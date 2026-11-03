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
 check(s,'doctorReviewed');d.getElementById('pdf').click();assert.equal(s.report.window.document.querySelector('img'),null);assert.ok(s.report.window.document.body.textContent.includes('<img'));assert.ok(!s.report.window.document.body.textContent.includes('test-token'));
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
 check(s,'doctorReviewed');d.getElementById('pdf').click();assert.equal(s.report.window.document.querySelectorAll('tbody tr').length,5);s.report.window.close();template.value='record';template.dispatchEvent(new w.Event('change'));
 assert.equal(d.getElementById('doctorReviewed').checked,true);assert.equal(s.calls.length,requests);assert.equal(d.querySelector('#notes textarea').value,original);
 assert.equal(d.querySelector('#reportPreview dd').textContent,'');assert.equal(d.getElementById('reportMetadata').hidden,false);
 d.getElementById('reportPatientId').value='<svg onload=alert(1)>架空ID';d.getElementById('reportPatientId').dispatchEvent(new w.Event('input'));
 assert.ok(d.getElementById('pdf').disabled);assert.equal(d.querySelector('#reportPreview svg'),null);assert.ok(d.getElementById('reportPreview').textContent.includes('<svg'));
 const area=d.querySelector('#notes textarea');area.value='修正済みの架空文\n次の行';area.dispatchEvent(new w.Event('input'));
 assert.ok(d.getElementById('reportPreview').textContent.includes('修正済みの架空文\n次の行'));
 check(s,'doctorReviewed');d.getElementById('pdf').click();
 const report=s.report.window.document;assert.ok(report.querySelector('.template-record'));assert.equal(report.querySelector('svg'),null);
 assert.ok(report.body.textContent.includes('修正済みの架空文\n次の行'));assert.ok(report.body.textContent.includes('架空ID'));assert.ok(report.body.textContent.includes('医師確認済み'));assert.ok(report.body.textContent.includes('要確認・未分類'));
 assert.equal(s.calls.length,requests);
 d.getElementById('demo').click();assert.equal(d.getElementById('reportPatientId').value,'');assert.ok(d.getElementById('pdf').disabled);
 d.getElementById('logout').click();assert.equal(template.value,'standard');assert.ok(d.getElementById('reportPreview').textContent.includes('見本'));assert.ok(!d.getElementById('reportPreview').textContent.includes('架空ID'));s.close();
});
