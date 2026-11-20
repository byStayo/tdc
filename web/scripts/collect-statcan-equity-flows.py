"""Private fixed StatCan original-issue source audit. No outcomes or private APIs."""
from html.parser import HTMLParser
from urllib.parse import urljoin,urlsplit
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from pathlib import Path
from hashlib import sha256
from datetime import datetime,timezone
import re,json,os,time,sys,subprocess,argparse
ROOT=Path(__file__).resolve().parents[1]/'.consensus/private-canada-equity-flows'
ALLOW_NETWORK=False
FROZEN_SHA256='6e4c905e16c774bc35bcc39e9e07dd8858f92d4c3fc960e3585c2d3dc5e3c2da'
HOST='https://www150.statcan.gc.ca'
FIRST='2016-01-19'; LAST='2026-10-16'
START=HOST+'/n1/daily-quotidien/261016/dq261016a-eng.htm'
MONTHS={name:i for i,name in enumerate(['January','February','March','April','May','June','July','August','September','October','November','December'],1)}
def norm(s):return ' '.join(s.split())
def canonical(url,base=HOST):
 u=urlsplit(urljoin(base,url))
 if u.scheme!='https' or u.netloc!='www150.statcan.gc.ca' or u.query or u.fragment:raise ValueError('Unapproved original source URL')
 p=u.path
 if p.startswith('/daily-quotidien/'):p='/n1'+p
 if not re.fullmatch(r'/n1/daily-quotidien/\d{6}/(?:dq\d{6}[a-z]|t\d{3}[a-z])-eng\.(?:htm|pdf)',p):raise ValueError('Unexpected original issue path')
 return HOST+p
class Page(HTMLParser):
 def __init__(self):
  super().__init__();self.text=[];self.h1=[];self.release=[];self.modified=[];self.links=[];self.tables=[]
  self.h=False;self.rel=False;self.mod=False;self.href=None;self.anchor=[];self.tdepth=0;self.rows=None;self.row=None;self.cell=None
 def handle_starttag(self,t,a):
  a=dict(a)
  if t=='h1':self.h=True
  if t=='p' and 'sd-release-date' in a.get('class','').split():self.rel=True
  if t=='time' and a.get('property')=='dateModified':self.mod=True
  if t=='a':self.href=a.get('href');self.anchor=[]
  if t=='table':
   self.tdepth+=1
   if self.tdepth==1:self.rows=[]
  if self.tdepth==1 and t=='tr':self.row=[]
  if self.tdepth==1 and t in ('td','th'):self.cell=[]
  if t=='br':self.handle_data(' ')
 def handle_data(self,s):
  self.text.append(s)
  if self.h:self.h1.append(s)
  if self.rel:self.release.append(s)
  if self.mod:self.modified.append(s)
  if self.href:self.anchor.append(s)
  if self.cell is not None:self.cell.append(s)
 def handle_endtag(self,t):
  if t=='h1':self.h=False
  if t=='p':self.rel=False
  if t=='time':self.mod=False
  if t=='a' and self.href:self.links.append((self.href,norm(''.join(self.anchor))));self.href=None
  if self.tdepth==1 and t in ('td','th') and self.cell is not None:
   if self.row is not None:self.row.append(norm(''.join(self.cell)))
   self.cell=None
  if self.tdepth==1 and t=='tr' and self.row is not None:self.rows.append(self.row);self.row=None
  if t=='table':
   if self.tdepth==1:self.tables.append(self.rows);self.rows=None
   self.tdepth-=1
 def plain(self):return norm(' '.join(self.text))
def parse_issue(s,url):
 url=canonical(url);p=Page();p.feed(s)
 title=norm(''.join(p.h1));m=re.fullmatch(r"Canada's international transactions in securities, ([A-Z][a-z]+) (\d{4})",title)
 if not m or m[1] not in MONTHS:raise ValueError('Unrecognized original issue title')
 dates=re.findall(r'\d{4}-\d{2}-\d{2}',norm(''.join(p.release)))
 if len(dates)!=1:raise ValueError('Missing unambiguous original release date')
 day=dates[0];expected=day[2:].replace('-','')
 if f'/{expected}/dq{expected}' not in url:raise ValueError('Original URL and release date differ')
 if norm(''.join(p.modified))!=day:raise ValueError('Original issue modification date differs')
 txt=p.plain().lower()
 if not re.search(r'all values in this release are net transactions',txt):raise ValueError('Net basis is not explicit in release')
 if 'common and preferred equities' not in txt and 'common and preferred shares' not in txt:raise ValueError('Equity definition missing')
 if 'investment fund' not in txt:raise ValueError('Fund-share population missing')
 prev=[canonical(h,url) for h,t in p.links if t=='Previous release']
 table=[canonical(h,url) for h,t in p.links if re.fullmatch(r"Table\s*1\s*Canada's international transactions in securities",t)]
 if len(prev)!=1 or len(table)!=1:raise ValueError('Original issue lacks unique previous/table link')
 if prev[0]>=url:raise ValueError('Archive previous link is not older')
 return {'issueDate':day,'referenceLabel':m[1]+' '+m[2],'referencePeriod':f'{m[2]}-{MONTHS[m[1]]:02d}',
  'source':url,'previous':prev[0],'table':table[0],'pdf':url[:-3]+'pdf','originalDatePrecision':'day',
  'definition':'Net acquisitions by nonresidents of Canadian equity and investment fund shares; direct investment excluded.',
  'revisionNote':bool(re.search(r'revision',txt))}
def previous_link(s,url):
 url=canonical(url);p=Page();p.feed(s)
 dates=re.findall(r'\d{4}-\d{2}-\d{2}',norm(''.join(p.release)))
 if len(dates)!=1:raise ValueError('Rejected issue lacks unambiguous release date for archive traversal')
 day=dates[0];compact=day[2:].replace('-','')
 if f'/{compact}/dq{compact}' not in url:raise ValueError('Rejected issue URL/date mismatch')
 prev=[canonical(h,url) for h,t in p.links if t=='Previous release']
 if len(prev)!=1 or prev[0]>=url:raise ValueError('Rejected issue lacks a unique older archive link')
 return day,prev[0]
def parse_table(s,reference,issue):
 p=Page();p.feed(s)
 if len(p.tables)!=1:raise ValueError('Expected exactly one original data table')
 if norm(''.join(p.modified))!=issue:raise ValueError('Table vintage differs from original release')
 rows=p.tables[0];headers=rows[0]
 indexes=[i for i,h in enumerate(headers) if h==reference]
 if len(indexes)!=1:raise ValueError('Missing or ambiguous exact current monthly column')
 col=indexes[0]
 if col!=3:raise ValueError('Exact current monthly column is not third monthly observation')
 if 'millions of dollars' not in p.plain():raise ValueError('Wrong flow units')
 txt=p.plain().lower()
 if not ('positive value denotes an increase in investment' in txt and 'negative value denotes a decrease in investment' in txt and 'transactions are recorded on a net basis' in txt):raise ValueError('Signed net definition missing')
 first=[i for i,r in enumerate(rows) if r and r[0]=='Foreign investment in Canadian securities']
 stop=[i for i,r in enumerate(rows) if r and r[0]=='Canadian investment in foreign securities']
 if len(first)!=1 or len(stop)!=1 or first[0]>=stop[0]:raise ValueError('Foreign and domestic populations ambiguous')
 matches=[r for r in rows[first[0]+1:stop[0]] if r and r[0]=='Equity and investment fund shares']
 if len(matches)!=1 or len(matches[0])!=len(headers):raise ValueError('Ambiguous foreign equity row')
 value=matches[0][col]
 if not re.fullmatch(r'-?(?:\d{1,3}(?:,\d{3})+|\d+)',value):raise ValueError('Flow is not an explicit signed integer')
 n=int(value.replace(',',''))
 return {'netCadMillions':n,'featureCadBillions':n/1000,'monthlyColumn':col,'referenceLabel':reference,'tableModified':issue}
def write_json(path,obj):
 b=(json.dumps(obj,indent=2,ensure_ascii=False)+'\n').encode()
 with path.open('xb') as f:f.write(b)
 os.chmod(path,0o600)
 return sha256(b).hexdigest()
class Capture:
 def __init__(self):
  self.raw=ROOT/'raw';self.raw.mkdir(mode=0o700,exist_ok=True);self.index={};self.previousStart=0;self.requests=0
  for path in ROOT.glob('*-receipt.json'):
   r=json.loads(path.read_text());self.index[r['url']]=r
  self.log=ROOT/'captures.jsonl'
  if self.log.exists():
   for line in self.log.read_text().splitlines():
    r=json.loads(line);self.index[r['url']]=r;self.requests+=1
 def get(self,url):
  if url in self.index:
   r=self.index[url]
   if 'error' in r:raise ValueError('Previously failed source: '+r['error'])
   b=(self.raw/r['bodyFile']).read_bytes()
   if sha256(b).hexdigest()!=r['sha256'] or len(b)!=r['bytes']:raise ValueError('Cached source differs from receipt')
   return b,r
  if not ALLOW_NETWORK:raise ValueError('Missing private cached source; collection requires explicit --collect')
  u=urlsplit(url)
  if u.scheme!='https' or u.hostname not in ('www150.statcan.gc.ca','www.statcan.gc.ca','www23.statcan.gc.ca') or u.username or u.password:raise ValueError('Unapproved source host')
  if self.requests>=280:raise ValueError('Fixed source request budget reached')
  time.sleep(max(0,2.1-(time.monotonic()-self.previousStart)));self.previousStart=time.monotonic();self.requests+=1
  r={'url':url,'retrievedAt':datetime.now(timezone.utc).isoformat()}
  try:
   with urlopen(Request(url,headers={'User-Agent':'DailyConsensusResearch/1.0 (private bounded aggregate source audit)'}),timeout=25) as response:
    b=response.read(1000001);r['finalUrl']=response.url;r['status']=response.status
    r['headers']={k:v for k,v in response.headers.items() if k.lower() in ('date','etag','last-modified','content-type')}
   if len(b)>1000000:raise ValueError('Source exceeds fixed body budget')
   if urlsplit(r['finalUrl']).hostname not in ('www150.statcan.gc.ca','www.statcan.gc.ca','www23.statcan.gc.ca'):raise ValueError('Source redirected to another host')
   h=sha256(b).hexdigest();p=self.raw/(h+'.bin')
   if not p.exists():
    with p.open('xb') as f:f.write(b)
    os.chmod(p,0o600)
   r.update(sha256=h,bytes=len(b),bodyFile=p.name)
  except Exception as e:r['error']=type(e).__name__+': '+str(e)
  with self.log.open('a') as f:f.write(json.dumps(r,ensure_ascii=False)+'\n')
  os.chmod(self.log,0o600);self.index[url]=r
  if 'error' in r:raise ValueError(r['error'])
  return b,r

def run():
 frozen_bytes=(ROOT/'frozen-candidate-v1.json').read_bytes()
 if sha256(frozen_bytes).hexdigest()!=FROZEN_SHA256:raise ValueError('Expected matching frozen historical cohort receipt')
 frozen=json.loads(frozen_bytes)
 if frozen['outcomeAccessBeforeFreeze'] is not False:raise ValueError('Invalid preregistration')
 output=ROOT/'source-complete-v1.json'
 if output.exists():
  data=json.loads(output.read_text())
  if data.get('frozenSha256')!=FROZEN_SHA256 or data.get('method')!=frozen['method']:raise ValueError('Cached original cohort differs')
  for row in data['rows']:
   raw=[]
   for key in ('issueReceipt','tableReceipt'):
    rec=row[key]
    if not re.fullmatch(r'[a-f0-9]{64}\.bin',rec['bodyFile']):raise ValueError('Invalid original capture path')
    b=(ROOT/'raw'/rec['bodyFile']).read_bytes()
    if sha256(b).hexdigest()!=rec['sha256'] or len(b)!=rec['bytes']:raise ValueError('Cached original source bytes differ')
    raw.append(b.decode('utf-8'))
   issue=parse_issue(raw[0],row['source']);value=parse_table(raw[1],issue['referenceLabel'],issue['issueDate'])
   for key in ('issueDate','referencePeriod','table'):
    if issue[key]!=row[key]:raise ValueError('Cached original identity differs')
   for key in ('netCadMillions','featureCadBillions'):
    if value[key]!=row[key]:raise ValueError('Cached original measured field differs')
  print(json.dumps({'status':'verified_cached_originals','summary':data['summary']}));return
 if not ALLOW_NETWORK:raise ValueError('Matching private source-complete-v1.json is required; no network is used by default')
 c=Capture();evidence={};errors=[]
 for key,url in [('robots',HOST+'/robots.txt'),('licence','https://www.statcan.gc.ca/en/terms-conditions/open-licence'),('methodology','https://www23.statcan.gc.ca/imdb/p2SV.pl?Function=getSurvey&SDDS=1535')]:
  try:
   b,r=c.get(url);evidence[key]=r
   if key=='robots' and b'Crawl-delay: 2' not in b:raise ValueError('Robots policy needs fresh review')
  except Exception as e:errors.append({'stage':key,'error':str(e)})
 timing=[]
 for url in [START[:-3]+'pdf',HOST+'/n1/daily-quotidien/160119/dq160119a-eng.pdf']:
  try:
   b,r=c.get(url);txt=subprocess.run(['pdftotext','-layout','-','-'],input=b,stdout=subprocess.PIPE,check=True,timeout=10).stdout.decode()
   if not re.search(r'Released at 8:30 a\.m\. Eastern time in The Daily',txt):raise ValueError('PDF does not confirm release time')
   timing.append({**r,'releaseLine':next(line.strip() for line in txt.splitlines() if 'Released at' in line)})
  except Exception as e:errors.append({'stage':'timing','source':url,'error':str(e)})
 rows=[];visited=set();url=START;chainComplete=False
 while len(visited)<131:
  if url in visited:errors.append({'stage':'chain','source':url,'error':'Cycle'});break
  visited.add(url)
  try:
   body,receipt=c.get(url);issue=parse_issue(body.decode('utf-8'),url)
  except Exception as e:
   errors.append({'stage':'issue','source':url,'error':str(e)})
   try:
    day,older=previous_link(body.decode('utf-8'),url)
    if day==FIRST:chainComplete=True;break
    if FIRST<day<=LAST:url=older;continue
   except Exception as traversal:errors.append({'stage':'chain','source':url,'error':str(traversal)})
   break
  day=issue['issueDate']
  if day<FIRST:chainComplete=True;break
  if day>LAST:errors.append({'stage':'range','source':url,'error':'Issue outside frozen range'});break
  try:
   body,tr=c.get(issue['table']);value=parse_table(body.decode('utf-8'),issue['referenceLabel'],day)
   rows.append({**issue,**value,'issueReceipt':receipt,'tableReceipt':tr})
  except Exception as e:errors.append({'stage':'table','source':issue['table'],'issueDate':day,'error':str(e)})
  if len(visited)%10==0:print(json.dumps({'progress':len(visited),'accepted':len(rows),'oldestIssue':day,'requests':c.requests}),flush=True)
  if day==FIRST:chainComplete=True;break
  url=issue['previous']
 rows.sort(key=lambda x:x['issueDate'])
 if len({r['issueDate'] for r in rows})!=len(rows) or len({r['referencePeriod'] for r in rows})!=len(rows):raise ValueError('Duplicate issue or monthly observation')
 if len(rows)>130:raise ValueError('Too many original releases for fixed monthly window')
 summary={'visitedIssues':len(visited),'acceptedOriginalReleases':len(rows),'chainComplete':chainComplete,
  'firstIssue':rows[0]['issueDate'] if rows else None,'lastIssue':rows[-1]['issueDate'] if rows else None,
  'firstReference':rows[0]['referencePeriod'] if rows else None,'lastReference':rows[-1]['referencePeriod'] if rows else None,
  'positive':sum(r['netCadMillions']>0 for r in rows),'negative':sum(r['netCadMillions']<0 for r in rows),'zero':sum(r['netCadMillions']==0 for r in rows),
  'networkRequests':c.requests,'rawBytes':sum(f.stat().st_size for f in c.raw.iterdir()),'errors':len(errors),
  'sourceGate':len(rows)>=120 and chainComplete and len(timing)>=1 and all(k in evidence for k in ['robots','licence','methodology'])}
 result={'method':frozen['method'],'frozenSha256':sha256((ROOT/'frozen-candidate-v1.json').read_bytes()).hexdigest(),'evidence':evidence,'timing':timing,'summary':summary,'errors':errors,'rows':rows,
 'sourceImplementationNote':'The first partial inventory is retained unchanged. Later-modified releases remain excluded while their date-validated older archive links may be traversed. The frozen timing contract is date precision; no failed endpoint timing probe is retried or required to infer intraday eligibility.',
 'timingPolicy':'Conservative end of each original release day in America/New_York, followed by first full US session with 08:00 cutoff strictly after that bound. The two PDFs verify endpoint 08:30; no historical intra-day time is inferred.',
 'attribution':frozen['attribution']}
 digest=write_json(output,result);print(json.dumps({'status':'saved_private_source_result','summary':summary,'receiptSha256':digest}),flush=True)
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__)
 modes=parser.add_mutually_exclusive_group();modes.add_argument('--collect',action='store_true');modes.add_argument('--cached-only',action='store_true')
 parser.add_argument('--private-root',type=Path,default=ROOT)
 args=parser.parse_args();ROOT=args.private_root.resolve();ALLOW_NETWORK=args.collect
 if not ROOT.is_dir() or ROOT.stat().st_mode & 0o077:raise ValueError('Expected an existing owner-only private root')
 run()
