(function(root){
 'use strict';
 const TEMPLATES={standard:'標準SOAP',table:'表形式',record:'診療記録票'};
 const LABELS={S:'S｜主観情報',O:'O｜客観情報',A:'A｜医師の評価',P:'P｜医師の計画',uncertain:'要確認・未分類'};
 const STYLE=`
 .soap-report{box-sizing:border-box;width:100%;max-width:210mm;margin:0 auto;padding:15mm;background:#fff;color:#203445;font-family:system-ui,sans-serif;font-size:14px;line-height:1.75;border:1px solid #d7e0e6;border-radius:4px;overflow-wrap:anywhere}
 .soap-report *{box-sizing:border-box}
 .soap-report .report-heading{padding:0 0 18px;border-bottom:2px solid #244e65;margin-bottom:22px}
 .soap-report .report-kicker{font-size:10px;letter-spacing:.16em;color:#597887;margin:0 0 7px}
 .soap-report h2{font-size:25px;letter-spacing:.04em;margin:0;color:#203d51}
 .soap-report .report-subtitle{font-size:12px;margin:5px 0 0;color:#607584}
 .soap-report .report-state{display:inline-block;font-size:11px;padding:3px 9px;background:#edf3f6;border:1px solid #ccdbe4;margin-top:12px;border-radius:4px}
 .soap-report .report-section{margin:0 0 20px}
 .soap-report h3{font-size:15px;margin:0 0 7px;color:#244e65;break-after:avoid}
 .soap-report .report-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.85}
 .soap-report .report-section[data-section=uncertain]{border-top:1px dashed #b9c9d4;padding-top:14px}
 .soap-report table{width:100%;border-collapse:collapse;table-layout:fixed;margin:18px 0}
 .soap-report caption{text-align:left;font-size:12px;color:#607584;margin-bottom:8px}
 .soap-report th,.soap-report td{border:1px solid #bcccd6;padding:12px;text-align:left;vertical-align:top}
 .soap-report th{width:27%;background:#edf3f6;font-size:13px;color:#244e65}
 .soap-report .report-meta{display:grid;grid-template-columns:1fr 1fr;gap:0;margin:0 0 24px;border-top:1px solid #bcccd6;border-left:1px solid #bcccd6}
 .soap-report .report-meta>div{padding:10px 12px;border-right:1px solid #bcccd6;border-bottom:1px solid #bcccd6;min-width:0}
 .soap-report dt{font-size:11px;color:#607584;margin:0}
 .soap-report dd{margin:3px 0 0;min-height:1.8em;white-space:pre-wrap}
 .soap-report.template-record .report-section{border-bottom:1px solid #d7e0e6;padding-bottom:16px}
 .soap-report .report-footer{border-top:1px solid #bcccd6;margin-top:24px;padding:12px 0 0;font-size:11px;color:#607584;break-inside:avoid}
 .soap-report .report-footer p{margin:4px 0;white-space:pre-wrap}
 @media(max-width:650px){.soap-report{padding:18px}.soap-report th,.soap-report td{padding:8px}.soap-report .report-meta{grid-template-columns:1fr}.soap-report h2{font-size:22px}}
 @media print{.soap-report{max-width:none;width:100%;padding:0;border:0;border-radius:0;font-size:11pt}.soap-report h2{font-size:19pt}.soap-report th,.soap-report td{padding:8px}.soap-report .report-meta{grid-template-columns:1fr 1fr}.soap-report .report-heading{break-inside:avoid}.soap-report th{-webkit-print-color-adjust:exact;print-color-adjust:exact}.report-print-controls{display:none!important}}
 @page{size:A4;margin:16mm}
 `;
 function templateName(value){return Object.hasOwn(TEMPLATES,value)?value:'standard';}
 function node(doc,tag,className,text){const el=doc.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;}
 function render(doc,{template='standard',sections={},metadata={},reviewed=false,example=false,issuedAt='',mode='extract'}){
  template=templateName(template);
  const report=node(doc,'article','soap-report template-'+template);
  report.setAttribute('aria-label',TEMPLATES[template]+'の帳票プレビュー');
  const header=node(doc,'header','report-heading');
  header.append(node(doc,'p','report-kicker','KTL / CLINICAL NOTES'),node(doc,'h2','',template==='record'?'診療記録票｜SOAP下書き':'SOAPカルテ下書き'),node(doc,'p','report-subtitle',TEMPLATES[template]+' · A4縦 · '+(mode==='summary'?'要約SOAP':'原文分類')),node(doc,'span','report-state',example?'テンプレート見本（診療記録ではありません）':reviewed?'医師確認済みの下書き':'未確認の下書き・印刷前に医師確認'));
  report.append(header);
  if(template==='record'){
   const meta=node(doc,'dl','report-meta');
   for(const [key,label] of [['patientId','患者ID'],['visitAt','診察日時'],['clinician','担当医'],['facility','施設名']]){
    const field=node(doc,'div');field.append(node(doc,'dt','',label),node(doc,'dd','',metadata[key]||''));meta.append(field);
   }report.append(meta);
  }
  if(template==='table'){
   const table=node(doc,'table');table.append(node(doc,'caption','','SOAP区分と記載内容'));
   const body=node(doc,'tbody');
   for(const [key,title] of Object.entries(LABELS)){
    const row=node(doc,'tr'),head=node(doc,'th','',title),cell=node(doc,'td');head.scope='row';row.dataset.section=key;
    cell.append(node(doc,'div','report-text',sections[key]||''));row.append(head,cell);body.append(row);
   }table.append(body);report.append(table);
  }else{
   for(const [key,title] of Object.entries(LABELS)){
    const section=node(doc,'section','report-section');section.dataset.section=key;
    section.append(node(doc,'h3','',title),node(doc,'div','report-text',sections[key]||''));report.append(section);
   }
  }
  const footer=node(doc,'footer','report-footer');
  footer.append(node(doc,'p','','医師確認：'+(example?'見本':reviewed?'確認済み':'未確認')),
   node(doc,'p','','出力日時：'+issuedAt),node(doc,'p','','記録補助の下書きです。自動保存・自動カルテ登録は行いません。'));
  report.append(footer);return report;
 }
 function plainText({sections={},metadata={},template='standard',issuedAt='',mode='extract'}){
  const meta=templateName(template)==='record'?['患者ID：'+(metadata.patientId||''),'診察日時：'+(metadata.visitAt||''),'担当医：'+(metadata.clinician||''),'施設名：'+(metadata.facility||'')].join('\n')+'\n\n':'';
  return 'SOAPカルテ下書き（医師確認済み・自動保存なし）\n出力日時：'+issuedAt+'\n作成方法：'+(mode==='summary'?'要約SOAP':'原文分類')+'\n\n'+meta+Object.entries(LABELS).map(([key,title])=>title+'\n'+(sections[key]||'')).join('\n\n');
 }
 const api={TEMPLATES,STYLE,render,plainText};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SOAPReport=api;
})(typeof window!=='undefined'?window:globalThis);
