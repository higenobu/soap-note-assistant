const {test}=require('node:test'),assert=require('node:assert/strict'),C=require('../static/core.js');
const rows=[{id:'u1',speaker:'患者',text:'架空の相談です。'},{id:'u2',speaker:'医師',text:'所見は記録を確認します。'},{id:'u3',speaker:'医師',text:'評価は保留です。'},{id:'u4',speaker:'医師',text:'次回相談します。'},{id:'u5',speaker:'不明',text:'確認できません。'}];
const valid=()=>({S:['u1'],O:['u2'],A:['u3'],P:['u4'],uncertain:['u5']});
test('原文・話者・発話IDからだけ下書きを構成',()=>{const groups=C.validateSOAP(JSON.stringify(valid()),rows);assert.equal(groups.S[0].text,rows[0].text);assert.ok(C.noteText(groups).S.includes('[u1 / 患者]'));assert.equal(C.noteText({S:[],O:[],A:[],P:[],uncertain:[]}).A,'記載なし（医師の確認が必要）');});
test('捏造・重複・欠落・自由記述・話者不明の断定を拒否',()=>{
 for(const mutate of [d=>d.S.push('u9'),d=>d.S.push('u1'),d=>d.A=[],d=>d.diagnosis='病名',d=>{d.O.push('u1');d.S=[];},d=>{d.A.push('u5');d.uncertain=[];}]){const data=valid();mutate(data);assert.throws(()=>C.validateSOAP(JSON.stringify(data),rows));}
});
test('発話数・文字数・ID・未入力を検証',()=>{assert.throws(()=>C.validateSegments([]));assert.throws(()=>C.validateSegments([{id:'u1',speaker:'患者',text:''}]));assert.throws(()=>C.validateSegments([rows[0],rows[0]]));assert.throws(()=>C.validateSegments(Array.from({length:7},(_,i)=>({id:'u'+(i+1),speaker:'患者',text:'a'.repeat(2000)}))));});
test('数値・否定・薬剤表現の確認フラグ',()=>{const flags=C.flags('薬は5mgではない。');assert.ok(flags.includes('数値・日付・用量'));assert.ok(flags.includes('否定表現'));assert.ok(flags.includes('薬剤名・単位'));});
