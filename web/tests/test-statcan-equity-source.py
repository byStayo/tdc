import unittest
from pathlib import Path
import importlib.util
spec=importlib.util.spec_from_file_location('statcan_equity_source',Path(__file__).resolve().parents[1]/'scripts/collect-statcan-equity-flows.py')
source=importlib.util.module_from_spec(spec);spec.loader.exec_module(source)
parse_table,parse_issue,canonical,previous_link=source.parse_table,source.parse_issue,source.canonical,source.previous_link

TABLE='''<table id="table01"><thead><tr><th></th><th>September<br>2015</th><th>October<br>2015</th><th>November<br>2015</th><th>January to November 2015</th></tr></thead><tbody><tr><th></th><td>millions of dollars</td></tr><tr><th>Foreign investment in Canadian securities</th><td>3,265</td><td>19,080</td><td>2,579</td><td>96,571</td></tr><tr><th>Equity and investment fund shares</th><td>1,000</td><td>2,000</td><td>-2,765</td><td>999,999</td></tr><tr><th>Canadian investment in foreign securities</th><td>1</td><td>2</td><td>3</td><td>4</td></tr><tr><th>Equity and investment fund shares</th><td>1</td><td>2</td><td>7,928</td><td>0</td></tr></tbody></table><p>In this table, a positive value denotes an increase in investment and a negative value denotes a decrease in investment. Transactions are recorded on a net basis.</p><time property="dateModified">2016-01-19</time>'''
ISSUE='''<h1>Canada's international transactions in securities, November 2015</h1><p class="sd-release-date">Released:&#160;2016-01-19</p><p>Equity and investment fund shares include common and preferred equities as well as units/shares of investment funds.</p><p>All values in this release are net transactions unless otherwise stated.</p><a href="/daily-quotidien/151216/dq151216a-eng.htm">Previous release</a><a href="t001a-eng.htm">Table 1Canada's international transactions in securities</a><time property="dateModified">2016-01-19</time>'''
class SourceTest(unittest.TestCase):
 def test_exact_latest_month_signed_foreign_flow(self):
  self.assertEqual(parse_table(TABLE,'November 2015','2016-01-19')['netCadMillions'],-2765)
 def test_no_current_revised_or_cumulative_substitution(self):
  with self.assertRaises(ValueError):parse_table(TABLE,'December 2015','2016-01-19')
  with self.assertRaises(ValueError):parse_table(TABLE.replace('November<br>2015','January to November 2015'),'November 2015','2016-01-19')
 def test_ambiguous_missing_or_later_table_is_rejected(self):
  for bad in [TABLE.replace('-2,765','..'), TABLE.replace('2016-01-19','2016-02-17'), TABLE.replace('<tr><th>Canadian investment', '<tr><th>Equity and investment fund shares</th><td>1</td><td>2</td><td>3</td><td>4</td></tr><tr><th>Canadian investment')]:
   with self.assertRaises(ValueError):parse_table(bad,'November 2015','2016-01-19')
 def test_original_issue_dates_links_and_definitions(self):
  parsed=parse_issue(ISSUE,'https://www150.statcan.gc.ca/n1/daily-quotidien/160119/dq160119a-eng.htm')
  self.assertEqual(parsed['issueDate'],'2016-01-19')
  self.assertEqual(parsed['referencePeriod'],'2015-11')
  self.assertEqual(parsed['previous'],'https://www150.statcan.gc.ca/n1/daily-quotidien/151216/dq151216a-eng.htm')
  self.assertEqual(parsed['table'],'https://www150.statcan.gc.ca/n1/daily-quotidien/160119/t001a-eng.htm')
  with self.assertRaises(ValueError):parse_issue(ISSUE.replace('2016-01-19','2016-01-20'),'https://www150.statcan.gc.ca/n1/daily-quotidien/160119/dq160119a-eng.htm')
 def test_later_modified_issue_is_excluded_without_truncating_older_inventory(self):
  later=ISSUE.replace('property="dateModified">2016-01-19','property="dateModified">2016-01-20')
  with self.assertRaises(ValueError):parse_issue(later,'https://www150.statcan.gc.ca/n1/daily-quotidien/160119/dq160119a-eng.htm')
  self.assertEqual(previous_link(later,'https://www150.statcan.gc.ca/n1/daily-quotidien/160119/dq160119a-eng.htm'),('2016-01-19','https://www150.statcan.gc.ca/n1/daily-quotidien/151216/dq151216a-eng.htm'))
 def test_no_unapproved_host_or_non_original_query(self):
  for bad in ['https://example.com/n1/daily-quotidien/160119/dq160119a-eng.htm','https://www150.statcan.gc.ca/n1/daily-quotidien/160119/dq160119a-eng.htm?latest=1']:
   with self.assertRaises(ValueError):canonical(bad)
if __name__=='__main__':unittest.main()
