const {test}=require('node:test'),assert=require('node:assert/strict'),C=require('../static/core.js');
const rows=[{id:'u1',speaker:'患者',text:'架空の相談です。'},{id:'u2',speaker:'医師',text:'所見は記録を確認します。'},{id:'u3',speaker:'医師',text:'評価は保留です。'},{id:'u4',speaker:'医師',text:'次回相談します。'},{id:'u5',speaker:'不明',text:'確認できません。'}];
const valid=()=>({S:['u1'],O:['u2'],A:['u3'],P:['u4'],uncertain:['u5']});
test('原文・話者・発話IDからだけ下書きを構成',()=>{const groups=C.validateSOAP(JSON.stringify(valid()),rows);assert.equal(groups.S[0].text,rows[0].text);assert.ok(C.noteText(groups).S.includes('[u1 / 患者]'));assert.equal(C.noteText({S:[],O:[],A:[],P:[],uncertain:[]}).A,'記載なし（医師の確認が必要）');});
test('捏造・重複・欠落・自由記述・話者不明の断定を拒否',()=>{
 for(const mutate of [d=>d.S.push('u9'),d=>d.S.push('u1'),d=>d.A=[],d=>d.diagnosis='病名',d=>{d.O.push('u1');d.S=[];},d=>{d.A.push('u5');d.uncertain=[];}]){const data=valid();mutate(data);assert.throws(()=>C.validateSOAP(JSON.stringify(data),rows));}
});
test('発話数・文字数・ID・未入力を検証',()=>{assert.throws(()=>C.validateSegments([]));assert.throws(()=>C.validateSegments([{id:'u1',speaker:'患者',text:''}]));assert.throws(()=>C.validateSegments([rows[0],rows[0]]));assert.throws(()=>C.validateSegments(Array.from({length:7},(_,i)=>({id:'u'+(i+1),speaker:'患者',text:'a'.repeat(2000)}))));});
test('数値・否定・薬剤表現の確認フラグ',()=>{const flags=C.flags('薬は5mgではない。');assert.ok(flags.includes('数値・日付・用量'));assert.ok(flags.includes('否定表現'));assert.ok(flags.includes('薬剤名・単位'));});
const summaryRows=[
 {id:'u1',speaker:'患者',text:'こんにちは。'},
 {id:'u2',speaker:'患者',text:'熱が38度あります。咳はありません。'},
 {id:'u3',speaker:'医師',text:'薬剤Xを5mg、1日2回処方します。'},
 {id:'u4',speaker:'患者',text:'熱が38度あります。咳はありません。'}
];
const summaryValid=()=>({S:[{text:'発熱38度。咳なし。',source_ids:['u2']}],O:[],A:[],P:[{text:'薬剤Xを5mg、1日2回処方。',source_ids:['u3']}],uncertain:[],omitted:[{id:'u1',reason:'挨拶',duplicate_of:null},{id:'u4',reason:'重複',duplicate_of:'u2'}]});
test('要約本文と根拠を分け、挨拶と完全一致の重複を省略候補へ残す',()=>{
 const result=C.validateSummary(JSON.stringify(summaryValid()),summaryRows);
 assert.equal(result.texts.S,'発熱38度。咳なし。');assert.equal(result.groups.S[0].id,'u2');assert.equal(result.omitted.length,2);assert.equal(result.omitted[1].source.text,summaryRows[3].text);
 assert.ok(!result.texts.S.includes('こんにちは'));assert.ok(!result.texts.S.includes('[u2'));
});
test('要約の根拠捏造・未計上の発話・診療内容の省略・不正な重複・役割違反を拒否',()=>{
 const mutations=[d=>d.S[0].source_ids=['u9'],d=>d.omitted.pop(),d=>{d.S=[];d.omitted.push({id:'u2',reason:'挨拶',duplicate_of:null});},d=>d.omitted[1].duplicate_of='u3',d=>{d.O=d.S;d.S=[];},d=>d.S[0].extra='unknown',d=>d.omitted[0].id='u2'];
 for(const mutate of mutations){const d=summaryValid();mutate(d);assert.throws(()=>C.validateSummary(JSON.stringify(d),summaryRows));}
 const unknown=summaryRows.map(r=>r.id==='u2'?{...r,speaker:'不明'}:r);assert.throws(()=>C.validateSummary(JSON.stringify(summaryValid()),unknown));
});
test('要約の数値・対応単位の追加変更と欠落を拒否し、全角表記を照合する',()=>{
 for(const value of ['発熱39度。咳なし。','発熱。咳なし。']){const d=summaryValid();d.S[0].text=value;assert.throws(()=>C.validateSummary(JSON.stringify(d),summaryRows));}
 const d=summaryValid();d.P[0].text='薬剤Xを50mg、1日2回処方。';assert.throws(()=>C.validateSummary(JSON.stringify(d),summaryRows));
 const full=summaryRows.map(r=>({...r,text:r.text.replace('38','３８').replace('5mg','５ｍｇ')}));assert.equal(C.validateSummary(JSON.stringify(summaryValid()),full).texts.S,'発熱38度。咳なし。');
 const small=[{id:'u1',speaker:'患者',text:'測定値5'},{id:'u2',speaker:'患者',text:'10です'}];
 assert.doesNotThrow(()=>C.validateSummary(JSON.stringify({S:[{text:'測定値5と10',source_ids:['u1','u2']}],O:[],A:[],P:[],uncertain:[],omitted:[]}),small));
});
test('はい・いいえを機械的に不要と判断して省略しない',()=>{
 for(const text of ['はい。','いいえ。','えっと、薬は飲んでいません。']){
  const source=[{id:'u1',speaker:'患者',text}],data={S:[],O:[],A:[],P:[],uncertain:[],omitted:[{id:'u1',reason:'つなぎ言葉',duplicate_of:null}]};assert.throws(()=>C.validateSummary(JSON.stringify(data),source));
 }
});
test('話者候補は不明の発話だけを対象とし、未知ID・重複・手動設定の上書き・人物名を拒否',()=>{
 const data={speakers:[{id:'u5',speaker:'患者'}]};assert.equal(C.validateSpeakers(JSON.stringify(data),rows)[0].speaker,'患者');
 for(const speakers of [[],[{id:'u1',speaker:'医師'}],[{id:'u5',speaker:'山田'}],[{id:'u5',speaker:'患者'},{id:'u5',speaker:'患者'}]])assert.throws(()=>C.validateSpeakers(JSON.stringify({speakers}),rows));
 const prompt=C.speakerPrompt(rows);assert.ok(prompt.includes('本人の識別ではありません'));assert.ok(prompt.includes('対象ID:["u5"]'));
});
test('確認済み分類の全ID・役割を検証し、人の省略指定を原文付きで保持する',()=>{
 const assignments={u1:'S',u2:'O',u3:'A',u4:'P',u5:'uncertain'};
 assert.equal(C.validateClassification(rows,assignments).groups.A[0].id,'u3');
 assert.throws(()=>C.validateClassification(rows,{...assignments,u1:'O'}));
 assert.throws(()=>C.validateClassification(rows,{...assignments,u5:'S'}));
 const missing={...assignments};delete missing.u2;assert.throws(()=>C.validateClassification(rows,missing));
 const result=C.validateClassification(rows,{...assignments,u1:'omit'});assert.equal(result.omitted[0].source.text,rows[0].text);assert.equal(result.groups.S.length,0);
});
test('区分別要約は他区分のID・再分類を拒否し、不足IDをエラーで示す',()=>{
 const source=[{id:'u10',speaker:'医師',text:'薬剤Xを5mg処方する方針です。'}];
 const response={items:[{text:'薬剤Xを5mg処方する方針。',source_ids:['u10']}],omitted:[]};
 assert.equal(C.validateSectionSummary(JSON.stringify(response),'P',source).texts.P,response.items[0].text);
 response.items[0].source_ids=['u2'];assert.throws(()=>C.validateSectionSummary(JSON.stringify(response),'P',source),/存在しない/);
 assert.throws(()=>C.validateSectionSummary(JSON.stringify({items:[],omitted:[]}),'P',source),/u10/);
 assert.throws(()=>C.validateSectionSummary(JSON.stringify({items:[],omitted:[],S:[]}),'P',source));
 const prompt=C.sectionSummaryPrompt('P',source);assert.ok(prompt.includes('分類を変更しません'));assert.ok(prompt.includes('不確実性を断定に変えず'));
});
