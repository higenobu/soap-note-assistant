'use strict';
const C=SOAPCore,R=SOAPReport,$=id=>document.getElementById(id);
let token='',rows=[],blob=null,audioUrl='',recorder=null,stream=null,recording=false,starting=false,busy=false,revision=0,authRevision=0,loginBusy=false,controller=null,timer=null,noteReady=false;
function status(id,text){$(id).textContent=text;}
function controls(){
 $('record').disabled=recording||starting||busy;$('stop').disabled=!recording;$('audioFile').disabled=recording||starting||busy;
 $('transcribe').disabled=!blob||!token||!$('asrConsent').checked||recording||busy||starting;
 $('generate').disabled=!token||!rows.length||!$('transcriptReviewed').checked||!$('soapConsent').checked||recording||busy||starting;
 $('loginBtn').disabled=loginBusy||busy||recording||starting;$('add').disabled=recording||starting||busy||rows.length>=200;$('demo').disabled=recording||starting||busy;
 $('copy').disabled=!noteReady||!$('doctorReviewed').checked;$('pdf').disabled=$('copy').disabled;updatePreview();
}
function invalidate(){revision++;if(controller)controller.abort();controller=null;busy=false;noteReady=false;$('result').hidden=true;$('notes').replaceChildren();$('doctorReviewed').checked=false;$('transcriptReviewed').checked=false;status('soapStatus','');status('exportStatus','');controls();}
function stopTracks(){if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;if(timer)clearTimeout(timer);timer=null;}
function clearAudio(){if(audioUrl)URL.revokeObjectURL(audioUrl);audioUrl='';blob=null;$('playback').pause();$('playback').removeAttribute('src');$('playback').hidden=true;}
function clearAll(logout=true){
 invalidate();authRevision++;loginBusy=false;if(logout)token='';
 if(recorder&&recorder.state!=='inactive')recorder.stop();recorder=null;recording=false;starting=false;stopTracks();clearAudio();rows=[];renderRows();$('audioFile').value='';$('password').value='';
 for(const id of ['recordConsent','asrConsent','soapConsent'])$(id).checked=false;
 if(logout){$('username').value='';status('authStatus','未ログイン');}else status('authStatus',token?'ログイン済み':'未ログイン');
 resetReport();status('recordStatus','録音・会話・結果を消去しました。');status('asrStatus','');controls();
}
function setAudio(source){clearAudio();blob=source;audioUrl=URL.createObjectURL(source);$('playback').src=audioUrl;$('playback').hidden=false;controls();}
function markEdited(){invalidate();status('soapStatus','会話を変更しました。文字起こしと話者を再確認してください。');}
function renderRows(){
 $('utterances').replaceChildren();
 rows.forEach((row,i)=>{
  row.id='u'+(i+1);const article=document.createElement('article');article.className='utterance';const top=document.createElement('header'),label=document.createElement('strong'),time=document.createElement('span'),speaker=document.createElement('select'),remove=document.createElement('button'),text=document.createElement('textarea'),flags=document.createElement('p');
  label.textContent=row.id;time.textContent=Number.isFinite(row.start)?row.start+'〜'+row.end+'秒':'手入力';speaker.setAttribute('aria-label',row.id+'の話者');
  for(const name of C.SPEAKERS){const option=document.createElement('option');option.value=name;option.textContent=name;speaker.append(option);}speaker.value=row.speaker;
  speaker.addEventListener('change',()=>{row.speaker=speaker.value;markEdited();});
  text.value=row.text;text.rows=3;text.maxLength=2000;text.setAttribute('aria-label',row.id+'の発話');
  const updateFlags=()=>{flags.textContent='確認：'+C.flags(row.text).join(' / ');};
  text.addEventListener('input',()=>{row.text=text.value;updateFlags();markEdited();});flags.className='flags';updateFlags();
  remove.type='button';remove.className='quiet';remove.textContent='削除';remove.addEventListener('click',()=>{invalidate();rows.splice(i,1);renderRows();});
  top.append(label,time,speaker,remove);article.append(top,text,flags);$('utterances').append(article);
 });controls();
}
async function jsonRequest(url,options){
 const response=await fetch(url,{cache:'no-store',...options});let data;
 try{data=await response.json();}catch{throw Error('API応答を読み取れませんでした。');}
 if(!response.ok){const error=Error(typeof data.detail==='string'?data.detail:'APIエラー（'+response.status+'）。');error.status=response.status;throw error;}return data;
}
function authError(error){if(error.status===401){token='';status('authStatus','再ログインまたは音声認識サービスの許可ユーザー設定を確認してください。');controls();}}
$('login').addEventListener('submit',async e=>{
 e.preventDefault();if(loginBusy||recording||starting)return;token='';invalidate();const version=++authRevision;loginBusy=true;controls();status('authStatus','ログイン中…');
 try{const data=await jsonRequest('/llmjp/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('username').value.trim(),password:$('password').value})});if(version!==authRevision)return;if(!data.access_token)throw Error('トークンを取得できませんでした。');token=data.access_token;$('password').value='';status('authStatus','ログイン済み');}
 catch(error){if(version===authRevision)status('authStatus',error.message);}
 finally{if(version===authRevision){loginBusy=false;controls();}}
});
$('logout').addEventListener('click',()=>clearAll());$('clear').addEventListener('click',()=>clearAll(false));
$('record').addEventListener('click',async()=>{
 if(recording||starting||busy)return;if(!$('recordConsent').checked){status('recordStatus','録音同意の確認にチェックしてください。');return;}
 if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){status('recordStatus','このブラウザでは録音できません。HTTPS対応ブラウザか音声ファイル入力を使用してください。');return;}
 resetReport(false);invalidate();rows=[];renderRows();clearAudio();starting=true;controls();const version=revision;let chunks=[],size=0,oversize=false,active;
 try{
  const acquired=await navigator.mediaDevices.getUserMedia({audio:true});if(version!==revision){acquired.getTracks().forEach(t=>t.stop());return;}stream=acquired;
  const mime=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'].find(type=>MediaRecorder.isTypeSupported(type));
  active=mime?new MediaRecorder(stream,{mimeType:mime,audioBitsPerSecond:64000}):new MediaRecorder(stream);recorder=active;
  active.ondataavailable=e=>{if(version!==revision||!e.data.size)return;size+=e.data.size;if(size>32*1024*1024){oversize=true;if(active.state!=='inactive')active.stop();return;}chunks.push(e.data);};
  active.onstop=()=>{
   if(version!==revision)return;recording=false;stopTracks();recorder=null;
   if(oversize){chunks=[];status('recordStatus','32MBを超えたため録音を破棄しました。短く分割してください。');}
   else if(chunks.length){setAudio(new Blob(chunks,{type:active.mimeType||mime||'audio/webm'}));chunks=[];status('recordStatus','録音を停止しました。原音を確認して送信してください。');}
   controls();
  };
  active.onerror=()=>{if(version===revision){invalidate();recording=false;recorder=null;stopTracks();status('recordStatus','録音エラーです。録音をやり直してください。');controls();}};
  active.start(1000);starting=false;recording=true;status('recordStatus','● 録音中。15分で自動停止します。');timer=setTimeout(()=>{if(active.state==='recording')active.stop();},15*60*1000);controls();
 }catch(error){if(version===revision){starting=false;stopTracks();status('recordStatus','マイクを使用できませんでした。ブラウザの許可と録音機器を確認してください。');controls();}}
});
$('stop').addEventListener('click',()=>{if(recorder?.state==='recording')recorder.stop();});
$('recordConsent').addEventListener('change',()=>{if(!$('recordConsent').checked){clearAll(false);status('recordStatus','録音同意を取り消し、録音と会話を消去しました。');}});
$('audioFile').addEventListener('change',()=>{
 const file=$('audioFile').files[0];if(!file)return;
 if(!$('recordConsent').checked){status('recordStatus','録音対象者の同意を確認してください。');$('audioFile').value='';return;}
 const mime=file.type.split(';')[0];if(file.size>32*1024*1024||!['audio/webm','audio/ogg','audio/wav','audio/x-wav','audio/mpeg','audio/mp4'].includes(mime)){status('recordStatus','対応する音声形式・32MB以内のファイルを選択してください。');$('audioFile').value='';return;}
 resetReport(false);invalidate();rows=[];renderRows();setAudio(file);status('recordStatus','音声ファイルを読み込みました。15分以内の音声を送信してください。');$('audioFile').value='';
});
$('asrConsent').addEventListener('change',()=>{if(busy){invalidate();status('asrStatus','送信待ちを中止しました。送信済みのサーバー処理は完了まで続く場合があります。');}controls();});
$('transcribe').addEventListener('click',async()=>{
 if(!blob||!token||!$('asrConsent').checked||busy)return;invalidate();const version=revision,auth=token;rows=[];renderRows();busy=true;controller=new AbortController();controls();status('asrStatus','音声を認識中…処理時間は音声の長さにより変わります。');
 try{const data=await jsonRequest('/soap-api/transcribe',{method:'POST',headers:{'Content-Type':blob.type||'audio/webm',Authorization:'Bearer '+auth},body:blob,signal:controller.signal});if(version!==revision||auth!==token)return;
  C.validateSegments(data.segments);if(data.segments.some(r=>r.speaker!=='不明'||!Number.isFinite(r.start)||!Number.isFinite(r.end)||r.start<0||r.end<r.start))throw Error('文字起こしの形式を確認できませんでした。');
  rows=data.segments.map(r=>({...r}));renderRows();status('asrStatus','文字起こし完了。話者はすべて未確認です。原音と照合して修正してください。');
 }catch(error){if(version===revision&&error.name!=='AbortError'){authError(error);status('asrStatus',error.message);}}
 finally{if(version===revision){busy=false;controller=null;controls();}}
});
$('add').addEventListener('click',()=>{if(rows.length>=200||busy)return;invalidate();rows.push({id:'u'+(rows.length+1),speaker:'不明',text:'',start:null,end:null});renderRows();});
$('demo').addEventListener('click',()=>{resetReport(false);invalidate();clearAudio();rows=[
 {id:'u1',speaker:'患者',text:'これは架空の会話です。昨日からの体調について相談したいです。'},
 {id:'u2',speaker:'医師',text:'診察所見は、原本の記録と照合してください。'},
 {id:'u3',speaker:'医師',text:'評価は現時点では保留です。'},
 {id:'u4',speaker:'医師',text:'記録を確認したうえで次回の方針を相談します。'}];renderRows();status('soapStatus','架空会話です。医療上の参考例ではありません。');});
for(const id of ['transcriptReviewed','soapConsent'])$(id).addEventListener('change',()=>{if(busy)invalidate();controls();});
$('generate').addEventListener('click',async()=>{
 if(!token||busy||!$('transcriptReviewed').checked||!$('soapConsent').checked)return;let snapshot;
 try{snapshot=JSON.parse(JSON.stringify(C.validateSegments(rows)));}catch(e){status('soapStatus',e.message);return;}
 const version=revision,auth=token;busy=true;noteReady=false;$('result').hidden=true;$('notes').replaceChildren();$('doctorReviewed').checked=false;controller=new AbortController();controls();status('soapStatus','会話をSOAPに分類し、発話IDと話者を検証中…');
 try{
  const data=await jsonRequest('/llmjp/generate',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth},body:JSON.stringify({prompt:C.prompt(snapshot),max_tokens:4096}),signal:controller.signal});
  if(version!==revision||auth!==token)return;const groups=C.validateSOAP(data.answer,snapshot),texts=C.noteText(groups);
  for(const [key,title]of Object.entries(C.SECTIONS)){
   const section=document.createElement('section'),heading=document.createElement('h3'),area=document.createElement('textarea'),details=document.createElement('details'),summary=document.createElement('summary'),evidence=document.createElement('p');section.className='note';heading.textContent=title;area.value=texts[key];area.rows=Math.max(3,Math.min(12,groups[key].length*2));area.dataset.section=key;area.setAttribute('aria-label',title+'の下書き');area.addEventListener('input',()=>{$('doctorReviewed').checked=false;status('exportStatus','編集した内容を医師が再確認してください。');controls();});summary.textContent='分類元の発話を確認';evidence.className='evidence';evidence.textContent=groups[key].map(r=>'['+r.id+' / '+r.speaker+'] '+r.text).join('\n')||'該当発話なし';details.append(summary,evidence);section.append(heading,area,details);$('notes').append(section);
  }
  noteReady=true;$('result').hidden=false;status('soapStatus','抽出型の下書きを作成しました。分類・内容は医師が確認してください。');
 }catch(error){if(version===revision&&error.name!=='AbortError'){authError(error);status('soapStatus',error.message+' 下書きは表示していません。');}}
 finally{if(version===revision){busy=false;controller=null;controls();}}
});
$('doctorReviewed').addEventListener('change',controls);
const reportStyle=document.createElement('style');reportStyle.textContent=R.STYLE;document.head.append(reportStyle);
const reportFieldIds=['reportPatientId','reportVisitAt','reportClinician','reportFacility'];
function reportData(){
 const sections=Object.fromEntries([...$('notes').querySelectorAll('textarea')].map(area=>[area.dataset.section,area.value]));
 return {template:$('reportTemplate').value,sections,metadata:{patientId:$('reportPatientId').value,visitAt:$('reportVisitAt').value.replace('T',' '),clinician:$('reportClinician').value,facility:$('reportFacility').value},reviewed:noteReady&&$('doctorReviewed').checked,example:!noteReady,issuedAt:new Date().toLocaleString('ja-JP')};
}
function resetReport(clearTemplate=true){for(const id of reportFieldIds)$(id).value='';if(clearTemplate)$('reportTemplate').value='standard';}
function updatePreview(){
 const data=reportData();$('reportMetadata').hidden=data.template!=='record';
 if(data.example)data.sections=Object.fromEntries(Object.entries(C.SECTIONS).map(([key,title])=>[key,title+'の内容がここに表示されます。']));
 $('reportPreview').replaceChildren(R.render(document,data));
 status('previewStatus',data.example?'テンプレート見本です。SOAP生成後は編集内容を表示します。':data.reviewed?'医師確認済み。選択した形式で印刷・PDF保存できます。':'編集内容のプレビューです。印刷前に医師が確認してください。');
}
$('reportTemplate').addEventListener('change',updatePreview);
for(const id of reportFieldIds)$(id).addEventListener('input',()=>{$('doctorReviewed').checked=false;status('exportStatus','基本情報を医師が再確認してください。');controls();});
function exportText(){return R.plainText(reportData());}
$('copy').addEventListener('click',async()=>{if(!noteReady||!$('doctorReviewed').checked)return;const version=revision;try{await navigator.clipboard.writeText(exportText());if(version===revision)status('exportStatus','下書きをコピーしました。');}catch{if(version===revision)status('exportStatus','コピーできませんでした。各欄を選択してコピーしてください。');}});
$('pdf').addEventListener('click',()=>{
 if(!noteReady||!$('doctorReviewed').checked)return;const report=window.open('','_blank');if(!report){status('exportStatus','ポップアップを許可してください。');return;}
 const d=report.document;d.title='SOAPカルテ下書き｜'+R.TEMPLATES[$('reportTemplate').value];d.documentElement.lang='ja';
 // Isolate the exported document from the editor; preserve text via textContent.
 report.opener=null;const style=d.createElement('style');style.textContent=R.STYLE+'body{margin:0;padding:24px;background:#eef2f5}.report-print-controls{max-width:210mm;margin:0 auto 16px;font:14px system-ui}.report-print-controls button{padding:10px 16px;cursor:pointer}@media print{body{padding:0;background:#fff}}';d.head.append(style);
 const actions=d.createElement('div'),button=d.createElement('button');actions.className='report-print-controls';button.textContent='印刷 / PDF保存';button.onclick=()=>report.print();actions.append(button);d.body.append(actions,R.render(d,reportData()));report.focus();
 status('exportStatus','選択した形式の印刷画面を開きました。印刷画面からPDF保存もできます。');
});
window.addEventListener('pageshow',()=>clearAll());window.addEventListener('pagehide',()=>clearAll());controls();
