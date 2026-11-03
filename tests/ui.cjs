const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');
const tick=()=>new Promise(r=>setImmediate(r));
async function setup(){
 const dom=new JSDOM(fs.readFileSync('static/index.html','utf8'),{runScripts:'outside-only',url:'https://llm-jp.com/soap/'}),w=dom.window,d=w.document,calls=[];let resolve,stops=0,opened;
 w.HTMLMediaElement.prototype.pause=function(){};w.URL.createObjectURL=()=> 'blob:test-audio';w.URL.revokeObjectURL=()=>{};
 Object.defineProperty(w.navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){stops++;}}]})}});
 w.MediaRecorder=class{static isTypeSupported(){return true;}constructor(){this.state='inactive';this.mimeType='audio/webm';}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable?.({data:new w.Blob(['audio'],{type:'audio/webm'})});this.onstop?.();}};
 w.fetch=async(url,options)=>{calls.push({url,options});if(url.endsWith('auth/login'))return {ok:true,json:async()=>({access_token:'test-token'})};return new Promise(r=>{resolve=r;});};
 w.open=()=>{opened=new JSDOM('<html><head></head><body></body></html>');return {document:opened.window.document,focus(){},print(){}};};
 w.eval(fs.readFileSync('static/core.js','utf8'));w.eval(fs.readFileSync('static/report.js','utf8'));w.eval(fs.readFileSync('static/app.js','utf8'));await tick();
 return {dom,w,d,calls,get stops(){return stops;},get report(){return opened;},resolve(data,status=200){resolve({ok:status===200,status,json:async()=>data});},close(){dom.window.close();opened?.window.close();}};
}
async function login(s){s.d.getElementById('username').value='demo';s.d.getElementById('password').value='test';s.d.getElementById('login').dispatchEvent(new s.w.Event('submit',{cancelable:true}));await tick();}
const check=(s,id)=>{s.d.getElementById(id).checked=true;s.d.getElementById(id).dispatchEvent(new s.w.Event('change'));};
function batchResult(s,answers){const prompts=JSON.parse(s.calls.at(-1).options.body).prompts;return {results:answers.map((answer,i)=>({prompt:prompts[i],answer:JSON.stringify(answer)}))};}
const batchAnswers=()=>['u1','u2','u3','u4'].map(id=>({items:[{text:'架空の要約',source_ids:[id]}],omitted:[]}));
test('同意前に録音しない。録音・停止・トラック解放・送信同意・消去後の遅延応答',async()=>{
 const s=await setup(),{d}=s;d.getElementById('record').click();assert.ok(d.getElementById('recordStatus').textContent.includes('同意'));assert.equal(s.calls.length,0);
 await login(s);check(s,'recordConsent');d.getElementById('record').click();await tick();assert.equal(d.getElementById('stop').disabled,false);assert.ok(d.getElementById('loginBtn').disabled);
 d.getElementById('stop').click();assert.equal(s.stops,1);assert.equal(d.getElementById('playback').hidden,false);assert.ok(d.getElementById('transcribe').disabled);
 check(s,'asrConsent');d.getElementById('transcribe').click();assert.equal(s.calls[1].url,'/soap-api/transcribe');assert.equal(s.calls[1].options.headers.Authorization,'Bearer test-token');
 d.getElementById('clear').click();s.resolve({segments:[{id:'u1',speaker:'不明',text:'遅延した発話',start:0,end:2}]});await tick();assert.equal(d.querySelectorAll('.utterance').length,0);assert.ok(d.getElementById('playback').hidden);assert.equal(s.w.localStorage.length,0);s.close();
});
test('SOAP原文抽出・医師確認・PDFのHTML無害化・編集後の再確認',async()=>{
 const s=await setup(),{d,w}=s;await login(s);d.getElementById('demo').click();
 const text=d.querySelector('.utterance textarea');text.value='<img src=x onerror=alert(1)>という架空の発話';text.dispatchEvent(new w.Event('input'));
 assert.ok(d.getElementById('generate').disabled);check(s,'transcriptReviewed');check(s,'soapConsent');d.getElementById('generate').click();s.resolve({answer:JSON.stringify({S:['u1'],O:['u2'],A:['u3'],P:['u4'],uncertain:[]})});await tick();
 assert.equal(d.getElementById('result').hidden,false);assert.equal(d.querySelectorAll('#notes textarea').length,5);assert.equal(d.querySelector('#notes img'),null);assert.ok(d.getElementById('pdf').disabled);
 check(s,'classificationReviewed');check(s,'doctorReviewed');d.getElementById('pdf').click();assert.equal(s.report.window.document.querySelector('img'),null);assert.ok(s.report.window.document.body.textContent.includes('<img'));assert.ok(!s.report.window.document.body.textContent.includes('test-token'));
 d.querySelector('#notes textarea').dispatchEvent(new w.Event('input'));assert.ok(d.getElementById('pdf').disabled);d.getElementById('logout').click();assert.ok(d.getElementById('result').hidden);assert.equal(d.querySelectorAll('.utterance').length,0);s.close();
});
test('不正なSOAP応答を表示しない',async()=>{
 const s=await setup(),{d}=s;await login(s);d.getElementById('demo').click();check(s,'transcriptReviewed');check(s,'soapConsent');d.getElementById('generate').click();s.resolve({answer:JSON.stringify({S:['u1'],O:['u2'],A:['invented'],P:['u4'],uncertain:[]})});await tick();assert.ok(d.getElementById('result').hidden);assert.ok(d.getElementById('soapStatus').textContent.includes('捏造'));s.close();
});
test('3種類の見本・生成後の切替・基本情報・編集と印刷プレビューの一致',async()=>{
 const s=await setup(),{d,w}=s,template=d.getElementById('reportTemplate');
 assert.equal(template.options.length,3);assert.ok(d.getElementById('reportPreview').textContent.includes('見本'));assert.ok(d.getElementById('pdf').disabled);
 template.value='table';template.dispatchEvent(new w.Event('change'));assert.equal(d.querySelectorAll('#reportPreview tbody tr').length,5);assert.equal(s.calls.length,0);
 await login(s);d.getElementById('demo').click();check(s,'transcriptReviewed');check(s,'soapConsent');d.getElementById('generate').click();s.resolve({answer:JSON.stringify({S:['u1'],O:['u2'],A:['u3'],P:['u4'],uncertain:[]})});await tick();
 const original=d.querySelector('#notes textarea').value,requests=s.calls.length;
 check(s,'classificationReviewed');check(s,'doctorReviewed');d.getElementById('pdf').click();assert.equal(s.report.window.document.querySelectorAll('tbody tr').length,5);s.report.window.close();template.value='record';template.dispatchEvent(new w.Event('change'));
 assert.equal(d.getElementById('doctorReviewed').checked,true);assert.equal(s.calls.length,requests);assert.equal(d.querySelector('#notes textarea').value,original);
 assert.equal(d.querySelector('#reportPreview dd').textContent,'');assert.equal(d.getElementById('reportMetadata').hidden,false);
 d.getElementById('reportPatientId').value='<svg onload=alert(1)>架空ID';d.getElementById('reportPatientId').dispatchEvent(new w.Event('input'));
 assert.ok(d.getElementById('pdf').disabled);assert.equal(d.querySelector('#reportPreview svg'),null);assert.ok(d.getElementById('reportPreview').textContent.includes('<svg'));
 const area=d.querySelector('#notes textarea');area.value='修正済みの架空文\n次の行';area.dispatchEvent(new w.Event('input'));
 assert.ok(d.getElementById('reportPreview').textContent.includes('修正済みの架空文\n次の行'));
 check(s,'classificationReviewed');check(s,'doctorReviewed');d.getElementById('pdf').click();
 const report=s.report.window.document;assert.ok(report.querySelector('.template-record'));assert.equal(report.querySelector('svg'),null);
 assert.ok(report.body.textContent.includes('修正済みの架空文\n次の行'));assert.ok(report.body.textContent.includes('架空ID'));assert.ok(report.body.textContent.includes('医師確認済み'));assert.ok(report.body.textContent.includes('要確認・未分類'));
 assert.equal(s.calls.length,requests);
 d.getElementById('demo').click();assert.equal(d.getElementById('reportPatientId').value,'');assert.ok(d.getElementById('pdf').disabled);
 d.getElementById('logout').click();assert.equal(template.value,'standard');assert.ok(d.getElementById('reportPreview').textContent.includes('見本'));assert.ok(!d.getElementById('reportPreview').textContent.includes('架空ID'));s.close();
});
test('原文分類を人が確認した後、区分別の原文だけを要約し帳票へ反映する',async()=>{
 const s=await setup(),{d,w}=s;await login(s);d.getElementById('demo').click();
 const area=d.querySelector('.utterance textarea');area.value='こんにちは。';area.dispatchEvent(new w.Event('input'));
 const mode=d.getElementById('soapMode');mode.value='summary';mode.dispatchEvent(new w.Event('change'));check(s,'transcriptReviewed');check(s,'soapConsent');
 d.getElementById('generate').click();assert.equal(JSON.parse(s.calls.at(-1).options.body).max_tokens,4096);
 s.resolve({answer:JSON.stringify({S:['u1'],O:['u2'],A:['u3'],P:['u4'],uncertain:[]})});await tick();
 assert.equal(d.getElementById('classification').hidden,false);assert.ok(d.getElementById('result').hidden);assert.ok(d.getElementById('summarize').disabled);
 const classify=d.querySelector('[aria-label="u1のSOAP分類"]');classify.value='omit';classify.dispatchEvent(new w.Event('change'));
 check(s,'classificationReviewed');assert.equal(d.getElementById('summarize').disabled,false);d.getElementById('summarize').click();
 assert.equal(s.calls.at(-1).url,'/llmjp/batch');const batch=JSON.parse(s.calls.at(-1).options.body);assert.equal(batch.prompts.length,3);assert.ok(batch.prompts[0].includes('対象ID:["u2"]'));assert.ok(!batch.prompts[0].includes('評価は現時点では保留です。'));
 const answers=[['u2','原本の記録で診察所見を照合。'],['u3','評価保留。'],['u4','記録確認後に次回方針を相談。']].map(([id,text])=>({items:[{text,source_ids:[id]}],omitted:[]}));
 s.resolve(batchResult(s,answers));await tick();
 assert.equal(d.getElementById('result').hidden,false);assert.equal(d.getElementById('omittedEvidence').hidden,false);assert.ok(d.getElementById('omittedList').textContent.includes('こんにちは'));
 assert.ok(d.querySelector('#notes details').textContent.includes('確認済み原文'));assert.ok(d.getElementById('reportPreview').textContent.includes('評価保留。'));assert.ok(!d.getElementById('reportPreview').textContent.includes('こんにちは'));
 assert.ok(d.getElementById('pdf').disabled);check(s,'doctorReviewed');d.getElementById('pdf').click();
 assert.ok(s.report.window.document.body.textContent.includes('評価保留。'));assert.ok(!s.report.window.document.body.textContent.includes('こんにちは'));assert.ok(!s.report.window.document.body.textContent.includes('u3 / 医師'));
 const calls=s.calls.length;mode.value='extract';mode.dispatchEvent(new w.Event('change'));assert.equal(d.getElementById('result').hidden,false);assert.ok(d.querySelector('#notes textarea').value.includes('記載なし'));assert.ok(d.getElementById('pdf').disabled);assert.equal(s.calls.length,calls);s.close();
});
test('要約方式を変更した後の遅延応答を表示しない',async()=>{
 const s=await setup(),{d,w}=s;await login(s);d.getElementById('demo').click();check(s,'transcriptReviewed');check(s,'soapConsent');d.getElementById('generate').click();
 d.getElementById('soapMode').value='summary';d.getElementById('soapMode').dispatchEvent(new w.Event('change'));
 s.resolve({answer:JSON.stringify({S:['u1'],O:['u2'],A:['u3'],P:['u4'],uncertain:[]})});await tick();assert.ok(d.getElementById('result').hidden);assert.ok(d.getElementById('reportPreview').textContent.includes('見本'));assert.equal(d.querySelectorAll('#notes textarea').length,0);s.close();
});
test('話者候補には認証・送信同意が必要で、手動設定を維持し仮入力後は人が再確認する',async()=>{
 const s=await setup(),{d,w}=s;d.getElementById('demo').click();const speaker=d.querySelector('.utterance select');speaker.value='不明';speaker.dispatchEvent(new w.Event('change'));
 assert.ok(d.getElementById('suggestSpeakers').disabled);await login(s);assert.ok(d.getElementById('suggestSpeakers').disabled);check(s,'soapConsent');assert.equal(d.getElementById('suggestSpeakers').disabled,false);
 d.getElementById('suggestSpeakers').click();assert.ok(JSON.parse(s.calls.at(-1).options.body).prompt.includes('話者の役割候補'));
 s.resolve({answer:JSON.stringify({speakers:[{id:'u1',speaker:'患者'}]})});await tick();
 assert.equal(d.querySelector('.utterance select').value,'患者');assert.equal(d.querySelectorAll('.utterance select')[1].value,'医師');assert.ok(d.querySelector('.speaker-suggestion').textContent.includes('未確認'));
 assert.equal(d.getElementById('transcriptReviewed').checked,false);assert.ok(d.getElementById('generate').disabled);check(s,'transcriptReviewed');assert.equal(d.getElementById('generate').disabled,false);assert.ok(d.querySelector('.speaker-suggestion').textContent.includes('確認済み'));
 const selected=d.querySelector('.utterance select');selected.value='家族';selected.dispatchEvent(new w.Event('change'));assert.equal(d.querySelector('.speaker-suggestion'),null);assert.ok(d.getElementById('generate').disabled);s.close();
});
test('話者推定中の消去で遅延候補を適用せず、形式不正の候補も適用しない',async()=>{
 for(const clear of [false,true]){
  const s=await setup(),{d,w}=s;await login(s);d.getElementById('demo').click();const speaker=d.querySelector('.utterance select');speaker.value='不明';speaker.dispatchEvent(new w.Event('change'));check(s,'soapConsent');d.getElementById('suggestSpeakers').click();
  if(clear)d.getElementById('clear').click();s.resolve({answer:JSON.stringify({speakers:[{id:clear?'u1':'u2',speaker:'医師'}]})});await tick();
  if(clear){assert.equal(d.querySelectorAll('.utterance').length,0);assert.equal(d.querySelector('.speaker-suggestion'),null);}
  else{assert.equal(d.querySelector('.utterance select').value,'不明');assert.ok(d.getElementById('speakerStatus').textContent.includes('変更していません'));}s.close();
 }
});
test('区分要約の検証失敗では分類を保持し、途中結果を表示しない',async()=>{
 const s=await setup(),{d,w}=s;await login(s);d.getElementById('demo').click();d.getElementById('soapMode').value='summary';d.getElementById('soapMode').dispatchEvent(new w.Event('change'));check(s,'transcriptReviewed');check(s,'soapConsent');d.getElementById('generate').click();
 s.resolve({answer:JSON.stringify({S:['u1'],O:['u2'],A:['u3'],P:['u4'],uncertain:[]})});await tick();check(s,'classificationReviewed');d.getElementById('summarize').click();
 const answers=batchAnswers();answers[1].items[0].source_ids=['u3'];s.resolve(batchResult(s,answers));await tick();
 assert.ok(d.getElementById('summaryStatus').textContent.includes('Oの要約'));assert.equal(d.getElementById('classification').hidden,false);assert.ok(d.getElementById('result').hidden);assert.equal(d.querySelectorAll('#notes textarea').length,0);assert.equal(d.querySelectorAll('.classification-row').length,4);s.close();
});
test('分類変更・原文編集で承認と要約を破棄し、遅延要約を復活させない',async()=>{
 for(const editSource of [false,true]){
  const s=await setup(),{d,w}=s;await login(s);d.getElementById('demo').click();d.getElementById('soapMode').value='summary';d.getElementById('soapMode').dispatchEvent(new w.Event('change'));check(s,'transcriptReviewed');check(s,'soapConsent');d.getElementById('generate').click();s.resolve({answer:JSON.stringify({S:['u1'],O:['u2'],A:['u3'],P:['u4'],uncertain:[]})});await tick();check(s,'classificationReviewed');d.getElementById('summarize').click();
  const pending=batchResult(s,batchAnswers());
  if(editSource){const area=d.querySelector('.utterance textarea');area.value='変更した原文';area.dispatchEvent(new w.Event('input'));}
  else{const select=d.querySelector('[aria-label="u1のSOAP分類"]');select.value='uncertain';select.dispatchEvent(new w.Event('change'));}
  s.resolve(pending);await tick();
  assert.ok(d.getElementById('result').hidden);assert.equal(d.getElementById('classificationReviewed').checked,false);assert.ok(d.getElementById('pdf').disabled);assert.equal(d.querySelectorAll('#notes textarea').length,0);assert.equal(d.getElementById('classification').hidden,editSource);s.close();
 }
});
test('要確認だけの場合は追加APIを呼ばず話者付き原文を保持する',async()=>{
 const s=await setup(),{d,w}=s;await login(s);d.getElementById('demo').click();d.getElementById('soapMode').value='summary';d.getElementById('soapMode').dispatchEvent(new w.Event('change'));check(s,'transcriptReviewed');check(s,'soapConsent');d.getElementById('generate').click();
 s.resolve({answer:JSON.stringify({S:[],O:[],A:[],P:[],uncertain:['u1','u2','u3','u4']})});await tick();const calls=s.calls.length;check(s,'classificationReviewed');d.getElementById('summarize').click();await tick();
 assert.equal(s.calls.length,calls);assert.equal(d.getElementById('result').hidden,false);assert.ok(d.querySelector('#notes textarea[data-section="uncertain"]').value.includes('患者：これは架空の会話です。'));assert.ok(d.getElementById('pdf').disabled);s.close();
});
test('バッチ応答の件数不足やプロンプト対応の入れ替わりを拒否する',async()=>{
 for(const swap of [false,true]){
  const s=await setup(),{d,w}=s;await login(s);d.getElementById('demo').click();d.getElementById('soapMode').value='summary';d.getElementById('soapMode').dispatchEvent(new w.Event('change'));check(s,'transcriptReviewed');check(s,'soapConsent');d.getElementById('generate').click();
  s.resolve({answer:JSON.stringify({S:['u1'],O:['u2'],A:['u3'],P:['u4'],uncertain:[]})});await tick();check(s,'classificationReviewed');d.getElementById('summarize').click();
  const data=batchResult(s,batchAnswers());if(swap)[data.results[0],data.results[1]]=[data.results[1],data.results[0]];else data.results.pop();s.resolve(data);await tick();
  assert.ok(d.getElementById('result').hidden);assert.equal(d.getElementById('classification').hidden,false);assert.ok(d.getElementById('summaryStatus').textContent.includes(swap?'対応':'件数'));s.close();
 }
});
