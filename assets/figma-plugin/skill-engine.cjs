const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
let serial=0;const nodes=new Map();
class Node{
 constructor(type,name){this.id=String(++serial);this.type=type;this.name=name;this.parent=null;this.children=[];this.visible=true;this.locked=false;this.width=120;this.height=40;this.relativeTransform=[[1,0,0],[0,1,0]];this.reactions=[];this.removed=false;nodes.set(this.id,this);}
 appendChild(n){if(n.parent)n.parent.children.splice(n.parent.children.indexOf(n),1);this.children.push(n);n.parent=this;}
 insertChild(i,n){if(n.parent)n.parent.children.splice(n.parent.children.indexOf(n),1);this.children.splice(i,0,n);n.parent=this;}
 resize(width,height){if(width<0.01||height<0.01)throw new Error('Invalid node dimensions');this.width=width;this.height=height;}
 findAll(cb){return this.children.flatMap(n=>[...(cb(n)?[n]:[]),...n.findAll(cb)]);}
 findAllWithCriteria(q){return this.findAll(n=>q.types.includes(n.type));}
 clone(){const n=new Node(this.type,this.name);for(const k of ['width','height','visible','locked','relativeTransform','characters','fontName','fontSize','reactions'])if(this[k]!==undefined)n[k]=JSON.parse(JSON.stringify(this[k]));for(const c of this.children)n.appendChild(c.clone());if(this.parent)this.parent.insertChild(this.parent.children.indexOf(this)+1,n);return n;}
 remove(){if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;this.removed=true;nodes.delete(this.id);for(const c of [...this.children])c.remove();}
 setPluginData(k,v){this[k]=v;}
 createInstance(){const n=this.clone();n.type='INSTANCE';n.main=this;return n;}
 async getMainComponentAsync(){return this.main;}
 getStyledTextSegments(){return this.characters?[{start:0,end:this.characters.length,characters:this.characters,fontName:this.fontName,fontSize:this.fontSize}]:[];}
}
const root=new Node('DOCUMENT','Test');const page=new Node('PAGE','Design');root.appendChild(page);page.selection=[];
const out=[];const figma={root,currentPage:page,ui:{postMessage:m=>out.push(m)},showUI(){},loadAllPagesAsync:async()=>{},getNodeByIdAsync:async id=>nodes.get(id)||null,loadFontAsync:async()=>{},createPage(){const n=new Node('PAGE','Page');root.appendChild(n);return n;},createComponentFromNode(n){n.type='COMPONENT';return n;},commitUndo(){},notify(){},viewport:{}};
const context={figma,__html__:'',console};vm.createContext(context);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../code.js'),'utf8'),context);
function source(name,text){const frame=new Node('FRAME',name),label=new Node('TEXT','Label');label.characters=text;label.fontName={family:'Inter',style:'Regular'};label.fontSize=14;frame.appendChild(label);page.appendChild(frame);return frame;}
let request=0;async function rpc(command,args={},id=`req-${++request}`){await figma.ui.onmessage({type:'skill-command',requestId:id,command,args});return out.filter(m=>m.type==='skill-result'&&m.requestId===id).at(-1);}
(async()=>{
 const a=source('Button A','First'),b=source('Button B','Second');
 const pageScan=await rpc('scan',{scope:'page'});assert(!pageScan.error,pageScan.error);assert.equal(pageScan.result.scope,'page');assert.equal(pageScan.result.candidates.length,2);
 const emptySelection=await rpc('scan',{scope:'selection'});assert.match(emptySelection.error,/选择/);
 const invalidScope=await rpc('scan',{scope:'invalid'});assert.match(invalidScope.error,/scope/);
 page.selection=[a,b];
 let scan=await rpc('scan');assert(!scan.error,scan.error);assert.equal(scan.result.candidates.length,2);assert.equal(scan.result.candidates[0].signature,scan.result.candidates[1].signature);
 a.children[0].characters='changed';let stale=await rpc('apply',{scanId:scan.result.scanId,families:[{name:'Button',sourceIds:[a.id,b.id]}]});assert.match(stale.error,/已改变/);assert(nodes.has(a.id));
 scan=await rpc('scan');let args={scanId:scan.result.scanId,families:[{name:'Button',sourceIds:[a.id,b.id]}]};let applied=await rpc('apply',args,'apply-once');assert(!applied.error,applied.error);assert.equal(applied.result.succeeded,2);assert.equal(applied.result.createdComponents.length,1);
 assert.equal(nodes.get(applied.result.entries[0].newNodeId).children[0].characters,'changed');assert.equal(nodes.get(applied.result.entries[1].newNodeId).children[0].characters,'Second');assert(!nodes.has(a.id));assert.equal(applied.result.backupPageId,null);assert.equal(applied.result.entries[0].backupNodeId,null);assert(!nodes.has(null));
 assert.equal(root.children.filter(n=>n.type==='PAGE').length,2);assert.equal(root.children.find(n=>n.name==='Skill Components').name,'Skill Components');
 let duplicate=await rpc('apply',args,'apply-once');assert.deepEqual(duplicate,applied);
 let verified=await rpc('verify',{entries:applied.result.entries});assert.equal(verified.result.verified,2);
 const c=source('Broken','Third');page.selection=[c];scan=await rpc('scan');figma.loadFontAsync=async()=>{throw new Error('font unavailable');};let failed=await rpc('apply',{scanId:scan.result.scanId,families:[{name:'Broken',sourceIds:[c.id]}]});assert(!failed.error,failed.error);assert.equal(failed.result.failed,1);assert(nodes.has(c.id));assert.equal(c.children[0].characters,'Third');assert.equal(page.children.filter(n=>n.type==='INSTANCE').length,2);figma.loadFontAsync=async()=>{};
 assert.equal(root.children.filter(n=>n.type==='PAGE').length,2);assert.equal(failed.result.generatedPageId,applied.result.generatedPageId);
 const d=source('Locked descendant','Fourth');d.children[0].locked=true;page.selection=[d];scan=await rpc('scan');assert.match(scan.result.candidates[0].blockedReason,/锁定/);let protectedApply=await rpc('apply',{scanId:scan.result.scanId,families:[{name:'No',sourceIds:[d.id]}]});assert.match(protectedApply.error,/锁定/);
 const e=source('Target','Fifth'),link=source('Link','Go');link.reactions=[{action:{type:'NODE',destinationId:e.id}}];page.selection=[e];scan=await rpc('scan');let incoming=await rpc('apply',{scanId:scan.result.scanId,families:[{name:'No',sourceIds:[e.id]}]});assert.match(incoming.error,/原型交互/);
 let wrongPage=await rpc('scan',{_bridgePageId:'other'});assert.match(wrongPage.error,/页面已切换/);
 for(let i=0;i<205;i++)page.appendChild(new Node('COMPONENT','Library '+i));
 let firstWindow=await rpc('scan');assert.equal(firstWindow.result.components.length,200);assert.equal(firstWindow.result.nextComponentOffset,200);assert(firstWindow.result.componentTotal>=205);
 let secondWindow=await rpc('scan',{componentOffset:200});assert.equal(secondWindow.result.nextComponentOffset,null);assert.equal(secondWindow.result.componentOffset,200);
 let invalidOffset=await rpc('scan',{componentOffset:-1});assert.match(invalidOffset.error,/非负整数/);
 e.visible=false;let skipped=await rpc('scan');assert.equal(skipped.result.skipped[0].id,e.id);assert.match(skipped.result.skipped[0].reason,/隐藏/);
 let ping=await rpc('ping');assert.equal(ping.result.pageName,'Design');
 console.log('PASS: page scope, empty selection, invalid scope, pagination, invalid offset, skipped reasons, ping page name; scan, compatibility, stale text rejection, component creation, unique text preservation, no-backup apply, idempotent retry, verification, failed font rollback, locked descendant protection, incoming prototype links, connected-page guard');
})().catch(e=>{console.error(e);process.exit(1)});
