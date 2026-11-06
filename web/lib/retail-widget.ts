import { createHash } from "node:crypto";
export const RETAIL_SCRIPT = "https://widgets.mfbcdn.net/scripts/fxOutlook.js?type=0&symbols=,1,2,3,5,11,29";
export const RETAIL_PROVIDER = "https://www.myfxbook.com/community/outlook";
export const RETAIL_SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";
export const RETAIL_READY = `(()=>{let sent=false;const report=status=>{if(sent)return;sent=true;parent.postMessage({type:'tdc-retail-frame',version:1,status},'*');};try{if(typeof showOutlookWidget!=='function')throw new Error();showOutlookWidget();const check=()=>{if(document.querySelector('table,iframe'))report('ready');};const observer=new MutationObserver(check);observer.observe(document.body,{subtree:true,childList:true});check();setTimeout(()=>{observer.disconnect();if(!sent)report('error');},12000);}catch{report('error');}})();`;
export function retailWidgetDocument() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Myfxbook FX community outlook</title><style>html,body{margin:0;padding:0;background:#fff;color:#111;font:14px Arial,sans-serif}body{box-sizing:border-box}a{color:#385a48}iframe{display:block;width:100%;height:270px;border:0}.attribution{display:flex;align-items:center;min-height:44px;padding:0 8px;font-size:11px}</style></head><body><div><script class="powered" type="text/javascript" src="${RETAIL_SCRIPT.replaceAll('&','&amp;')}"></script></div><div class="attribution"><a href="https://www.myfxbook.com" class="myfxbookLink" target="_blank" rel="noopener">Powered by Myfxbook.com</a></div><script>${RETAIL_READY}</script></body></html>`;
}
export function retailWidgetCSP() {
  return [
    `sandbox ${RETAIL_SANDBOX}`,
    "default-src 'none'",
    `script-src 'sha256-${createHash('sha256').update(RETAIL_READY).digest('base64')}' https://widgets.mfbcdn.net`,
    "style-src 'unsafe-inline' https://*.mfbcdn.net https://*.myfxbook.com",
    "img-src data: https://*.mfbcdn.net https://*.myfxbook.com",
    "connect-src https://*.mfbcdn.net https://*.myfxbook.com",
    "frame-src https://*.mfbcdn.net https://*.myfxbook.com",
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
  ].join('; ');
}
