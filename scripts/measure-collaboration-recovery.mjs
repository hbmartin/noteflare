import { receiptMeasurementState } from "./collaboration-measurement.mjs";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve as resolvePath } from "node:path";

const baseline = process.argv[2] ?? "ac826e9";
const output = process.argv[3];
const corruptStorage = process.argv[4] === "--corrupt-storage";
const measureReadRecovery = process.env.NOTES_BENCH_READ_RECOVERY === "1";
const typingEdits = Number(process.env.NOTES_BENCH_TYPING_EDITS ?? 20);
if (!Number.isSafeInteger(typingEdits) || typingEdits < 20 || typingEdits > 10000)
  throw new Error("Invalid typing sample count");
const root = process.cwd();
const controlled =
  /src\/client\/(CollaborativeTablePage|CellDraftRecovery|cell-drafts|table-connection|comment-publication|linked-table-reads|linked-table-query|table-view-state)\.(ts|tsx)$/;
const entry = `
${receiptMeasurementState.toString()}
import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {CollaborativeTablePage} from './src/client/CollaborativeTablePage';
import {tableConnection} from './src/client/table-connection';
import {readLinkedTable} from './src/client/linked-table-query';
import {linkedTableReads} from './src/client/linked-table-reads';
import {registerCommentPublication,initializeCommentPublications,useCommentPublicationWarning} from './src/client/comment-publication';
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const percentile=(values,q)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*q)-1];
const column=(id,type)=>({id,name:id,type,position:0,revision:1,generation:1,options:[]});
globalThis.__data={protocolVersion:1,pageId:'table',generation:1,revision:1,projectedRevision:1,canEdit:true,
 columns:[column('Title','text'),column('Amount','number'),column('Done','checkbox')],views:[],view:null,
 rows:Array.from({length:100},(_,i)=>({id:'row'+i,position:i,cells:{Title:'Original '+i,Amount:i,Done:false},cellRevisions:{Title:1,Amount:1,Done:1},detailPageId:null,createdAt:1,createdBy:null,editedAt:1,editedBy:null})),rowCount:100,groupCounts:{},nextCursor:null,invalidView:false};
globalThis.__requests=0;
globalThis.measureTyping=async()=>{
 localStorage.clear();
 for(let i=0;i<5000;i++)localStorage.setItem('unrelated:'+i,'other');
 for(let i=0;i<500;i++){
  const key=JSON.stringify(['row'+i,'Title']);
  const scope={account:'bench\\0wiki',host:'other',tableId:'other',generation:1};
  localStorage.setItem('notes:cell-draft:v1:'+JSON.stringify([scope.account,scope.host,scope.tableId,1,key]),JSON.stringify({scope,changed:true,rowId:'row'+i,columnId:'Title',type:'text',text:'Recovered '+i,baseRevision:1,version:'v'+i,durable:true}));
 }
 if(${corruptStorage})localStorage.setItem('notes:cell-draft:v1:'+JSON.stringify(['bench\\0wiki','other','other',1,JSON.stringify(['corrupt','Title'])]),'{broken');
 const host=document.createElement('div');document.body.append(host);const tree=createRoot(host);
 flushSync(()=>tree.render(createElement(CollaborativeTablePage,{page:{id:'table',title:'Measurement'},member:{role:'editor',user:{id:'bench'},workspace:{id:'wiki'},features:{}},queryBase:'/linked',onSelectPage(){}})));
 let input;
 for(let i=0;i<100;i++){await frame();input=host.querySelector('input[aria-label="Title"]');if(input&&!input.disabled)break;}
 if(!input||input.disabled)throw Error('Table never became editable');
 input.focus();
 const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
 const edit=text=>flushSync(()=>{setter.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}));});
 await frame();
 const count={length:0,key:0,writes:0};
 const descriptor=Object.getOwnPropertyDescriptor(Storage.prototype,'length'),key=Storage.prototype.key,set=Storage.prototype.setItem;
 Object.defineProperty(Storage.prototype,'length',{configurable:true,get(){count.length++;return descriptor.get.call(this)}});
 Storage.prototype.key=function(...args){count.key++;return key.apply(this,args)};
 Storage.prototype.setItem=function(...args){count.writes++;return set.apply(this,args)};
 globalThis.__wholeTableRenders=0;const durations=[];
 try{
  for(let i=0;i<${typingEdits};i++){const started=performance.now();edit('Measured draft '+i);durations.push(performance.now()-started);}
  if(![...Object.keys(localStorage)].some(key=>localStorage.getItem(key)?.includes('Measured draft ${typingEdits - 1}')))throw Error('No actual persisted input events');
  const result={samples:durations.length,firstEditMs:durations[0],p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),counts:{...count,wholeTableRenders:globalThis.__wholeTableRenders},requests:globalThis.__requests};
  globalThis.__draftNotifications=0;
  input.blur();
  for(let i=0;i<100;i++){await frame();if(globalThis.__requests>=3&&!input.disabled)break;}
  result.saveFocusNotifications=globalThis.__draftNotifications;
  return result;
 }finally{Object.defineProperty(Storage.prototype,'length',descriptor);Storage.prototype.key=key;Storage.prototype.setItem=set;tree.unmount();host.remove();}
};
globalThis.measureReceipts=async()=>{
 const scope={account:'receipt-bench',pageId:'page',epoch:1};initializeCommentPublications(scope);
 const count={length:0,key:0,writes:0,removes:0},durations=[];
 const descriptor=Object.getOwnPropertyDescriptor(Storage.prototype,'length'),key=Storage.prototype.key,set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
 Object.defineProperty(Storage.prototype,'length',{configurable:true,get(){count.length++;return descriptor.get.call(this)}});
 Storage.prototype.key=function(...args){count.key++;return key.apply(this,args)};
 Storage.prototype.setItem=function(...args){count.writes++;return set.apply(this,args)};
 Storage.prototype.removeItem=function(...args){count.removes++;return remove.apply(this,args)};
 try{
  for(let i=0;i<20;i++){const start=performance.now();registerCommentPublication(scope,'operation-'+i,async()=>{}).finish();durations.push(performance.now()-start);}
  return {samples:durations.length,p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),counts:count};
 }finally{Object.defineProperty(Storage.prototype,'length',descriptor);Storage.prototype.key=key;Storage.prototype.setItem=set;Storage.prototype.removeItem=remove;}
};
globalThis.measureReceiptSubscriptions=async()=>{
 const host=document.createElement('div');document.body.append(host);const tree=createRoot(host);
 const scope={account:'subscription-bench',pageId:'page',epoch:1};
 function Notice({sequence}){return createElement('span',null,useCommentPublicationWarning(scope),sequence);}
 flushSync(()=>tree.render(createElement(Notice,{sequence:0})));await frame();
 globalThis.__receiptSubscriptions=0;globalThis.__receiptUnsubscriptions=0;
 try{
  for(let sequence=1;sequence<=20;sequence++)flushSync(()=>tree.render(createElement(Notice,{sequence})));
  return {renders:20,subscriptions:globalThis.__receiptSubscriptions,unsubscriptions:globalThis.__receiptUnsubscriptions};
 }finally{tree.unmount();host.remove();}
};
globalThis.measureReadRecovery=async()=>{
 // Compare scheduler work with the same equal-jitter draw in both versions.
 const originalRandom=Math.random;Math.random=()=>0.5;
 const host=document.createElement('div');document.body.append(host);const tree=createRoot(host);
 globalThis.__requests=0;
 flushSync(()=>tree.render(createElement(CollaborativeTablePage,{page:{id:'table',title:'Read measurement'},member:{role:'editor',user:{id:'read-bench'},workspace:{id:'wiki'},features:{}},queryBase:'/linked',onSelectPage(){}})));
 try{
  let input;
  for(let i=0;i<100;i++){await frame();input=host.querySelector('input[aria-label="Title"]');if(input&&!input.disabled)break;}
  if(!input||input.disabled)throw Error('Read fixture never became editable');
  globalThis.__failNextRead=true;const start=performance.now();
  [...host.querySelectorAll('button')].find(button=>button.textContent==='Refresh').click();
  const deadline=start+20000;
  let interrupted=false;
  while(performance.now()<deadline){await frame();if(input.disabled)interrupted=true;if(interrupted&&!input.disabled)break;}
  if(!interrupted||input.disabled)throw Error('Read recovery did not complete');
  return {latencyMs:performance.now()-start,queries:globalThis.__requests};
 }finally{Math.random=originalRandom;tree.unmount();host.remove();}
};
globalThis.measurePagination=async()=>{
 const host=document.createElement('div');document.body.append(host);const tree=createRoot(host);
 globalThis.__pagedRows=Array.from({length:1200},(_,index)=>({...globalThis.__data.rows[0],id:'paged'+index,position:index,cells:{Title:'Paged '+index,Amount:index,Done:false}}));
 globalThis.__pageQueries=[];
 flushSync(()=>tree.render(createElement(CollaborativeTablePage,{page:{id:'table',title:'Pagination measurement'},member:{role:'editor',user:{id:'page-bench'},workspace:{id:'wiki'},features:{}},queryBase:'/linked',onSelectPage(){}})));
 const count=()=>host.querySelectorAll('input[aria-label="Title"]').length;
 const button=text=>[...host.querySelectorAll('button')].find(item=>item.textContent.trim()===text);
 const rows=async expected=>{for(let i=0;i<300;i++){await frame();if(count()===expected)return;}throw Error('Unexpected visible extent '+count()+' expected '+expected)};
 try{
  await rows(100);
  for(const expected of [200,300,400,500]){button('Load more rows').click();await rows(expected);}
  const durations=[],queryCounts=[];
  for(let sample=0;sample<5;sample++){
   const before=globalThis.__pageQueries.length,renders=globalThis.__wholeTableRenders,start=performance.now();
   button('Refresh').click();
   for(let i=0;i<300;i++){await frame();if(globalThis.__wholeTableRenders>renders)break;}
   await rows(500);
   durations.push(performance.now()-start);queryCounts.push(globalThis.__pageQueries.length-before);
  }
  const before=globalThis.__pageQueries.length;button('Load more rows').click();await rows(600);
  const firstContinuationQueries=globalThis.__pageQueries.length-before;
  const bufferedBefore=globalThis.__pageQueries.length;button('Load more rows').click();await rows(700);
  return {refreshSamples:durations.length,p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),refreshQueries:queryCounts,firstContinuationQueries,bufferedContinuationQueries:globalThis.__pageQueries.length-bufferedBefore,visibleRows:count(),requests:globalThis.__pageQueries};
 }finally{globalThis.__pagedRows=null;tree.unmount();host.remove();}
};
globalThis.measureQueryVerification=async()=>{
 const host=document.createElement('div');document.body.append(host);const tree=createRoot(host);
 flushSync(()=>tree.render(createElement(CollaborativeTablePage,{page:{id:'table',title:'Query measurement'},member:{role:'editor',user:{id:'query-bench'},workspace:{id:'wiki'},features:{}},queryBase:'/linked',onSelectPage(){}})));
 const button=text=>[...host.querySelectorAll('button')].find(item=>item.textContent.trim()===text);
 const ready=()=>host.querySelector('input[aria-label="Title"]')&&!host.querySelector('input[aria-label="Title"]').disabled;
 for(let i=0;i<100&&!ready();i++)await frame();
 if(!ready())throw Error('Query fixture not ready');
 const durations=[],renderCounts=[],queries=[];let toolbarReplacements=0,controlsMissingDuringVerification=0;
 try{
  for(let sample=0;sample<20;sample++){
   const views=button('Views'),properties=button('Properties'),before=globalThis.__requests,renders=globalThis.__wholeTableRenders,start=performance.now();
   const input=host.querySelector('input[aria-label="Search table"]');
   flushSync(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Query '+sample);input.dispatchEvent(new Event('input',{bubbles:true}));});
   if(!button('Views')||!button('Properties'))controlsMissingDuringVerification++;
   for(let i=0;i<100;i++){await frame();if(ready()&&globalThis.__requests>before)break;}
   if(!ready()||globalThis.__requests===before)throw Error('Query verification did not complete');
   toolbarReplacements+=Number(button('Views')!==views)+Number(button('Properties')!==properties);
   durations.push(performance.now()-start);renderCounts.push(globalThis.__wholeTableRenders-renders);queries.push(globalThis.__requests-before);
  }
  return {samples:20,p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),toolbarReplacements,controlsMissingDuringVerification,renderCounts,queries};
 }finally{tree.unmount();host.remove();}
};
globalThis.measureViewSwitch=async()=>{
 const previous=globalThis.__data;
 globalThis.__data={...previous,views:[{id:'grid',name:'Grid',kind:'grid',revision:1,ownerId:null,columnId:null,filters:null,sorts:[],visibleColumnIds:previous.columns.filter(column=>column.id!=='Done').map(column=>column.id)}]};
 const host=document.createElement('div');document.body.append(host);const tree=createRoot(host);
 flushSync(()=>tree.render(createElement(CollaborativeTablePage,{page:{id:'table',title:'View measurement'},member:{role:'editor',user:{id:'view-bench'},workspace:{id:'wiki'},features:{}},queryBase:'/linked',onSelectPage(){}})));
 const button=text=>[...host.querySelectorAll('button')].find(item=>item.textContent.trim()===text);
 const ready=()=>button('Views')&&!button('Views').disabled;
 const settle=async before=>{for(let i=0;i<100;i++){await frame();if(ready()&&globalThis.__requests>before)return;}throw Error('View did not verify');};
 const change=(input,value)=>flushSync(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});
 const select=value=>flushSync(()=>{const input=host.querySelector('select[aria-label="Saved table view"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('change',{bubbles:true}));});
 const durations=[],renderCounts=[],queries=[];let restored=0;
 try{
  for(let i=0;i<100&&!ready();i++)await frame();
  if(!ready())throw Error('View fixture not ready');
  button('Properties').click();await frame();
  for(let sample=0;sample<20;sample++){
   change(host.querySelector('input[aria-label="New property name"]'),'All '+sample);
   const renders=globalThis.__wholeTableRenders,before=globalThis.__requests,start=performance.now();
   select('grid');await settle(before);
   const headers=[...host.querySelectorAll('table thead th')].map(node=>node.firstChild?.textContent);
   if(!headers.includes('Title')||!headers.includes('Amount')||headers.includes('Done'))throw Error('Saved-view visible columns were not applied');
   if(!host.querySelector('input[aria-label="New property name"]')){button('Properties').click();await frame();}
   change(host.querySelector('input[aria-label="New property name"]'),'Grid '+sample);
   const back=globalThis.__requests;select('');await settle(back);
   restored+=Number(host.querySelector('input[aria-label="New property name"]')?.value==='All '+sample);
   durations.push(performance.now()-start);renderCounts.push(globalThis.__wholeTableRenders-renders);queries.push(globalThis.__requests-before);
  }
  return {samples:20,p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),restored,renderCounts,queries};
 }finally{tree.unmount();host.remove();globalThis.__data=previous;}
};
globalThis.measureFreshnessCompletion=async()=>{
 const durations=[],reads=[],outcomes=[];
 for(let sample=0;sample<10;sample++){
  let finish=null,count=0,finishedAt=0;
  const controller=linkedTableReads({poll:false,unavailable(){},read:()=>new Promise(resolve=>{count++;finish=()=>{finish=null;resolve({state:'success',value:1,verification:'network'});};})});
  const started=performance.now();
  const first=controller.verifyReceipt().then(value=>{finishedAt=performance.now();return value;});
  try{
   for(let event=0;event<8;event++){void controller.invalidate();if(finish)finish();await frame();}
   if(finish)finish();
   const outcome=await first;
   durations.push(finishedAt-started);reads.push(count);outcomes.push(receiptMeasurementState(outcome));
  }finally{controller.dispose();}
 }
 return {samples:10,invalidationsPerSample:8,p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),reads,outcomes,meaning:'Caller completion under controlled invalidation churn; pending is not fresh verification.'};
};
globalThis.measureFulfilledContinuations=async()=>{
 const current={data:globalThis.__data,buffered:[],serverCursor:null,pageSize:100,queryIdentity:'noop',verified:true,hasMore:false,continuation:null};
 const durations=[];let requests=0,sameWindows=0,sameData=0,sameRows=0;
 const read=async()=>{requests++;return globalThis.__data};
 for(let sample=0;sample<1000;sample++){
  const start=performance.now();const result=await readLinkedTable({kind:'append',queryIdentity:'noop',generation:1,target:100},current,read,undefined,'noop');
  durations.push(performance.now()-start);sameWindows+=Number(result.window===current);sameData+=Number(result.window.data===current.data);sameRows+=Number(result.window.data.rows===current.data.rows);
 }
 return {samples:1000,p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),requests,sameWindows,sameData,sameRows};
};
globalThis.measureSchedulerProgress=async()=>{
 let pages=0,release;
 const controller=linkedTableReads({poll:false,unavailable(){},coverage:value=>value,read:async intent=>{
  if(intent.kind==='refresh'||++pages>50)return {state:'failure'};
  if(pages===1)return new Promise(resolve=>{release=resolve});
  return {state:'success',value:{generation:1,revision:1},verification:'buffer'};
 }});
 try{
  void controller.page({queryIdentity:'progress',generation:1,revision:1,prefix:1,cursor:'next',target:300});
  void controller.refresh({generation:1,revision:2});
  release({state:'success',value:{generation:1,revision:1},verification:'network'});
  const started=performance.now();
  const callsBeforeTimer=await new Promise(resolve=>setTimeout(()=>resolve(pages),0));
  return {callsBeforeTimer,timerLatencyMs:performance.now()-started,safetyStop:50};
 }finally{controller.dispose()}
};
globalThis.measureCommitCompletion=async()=>{
 const host=document.createElement('div');document.body.append(host);const tree=createRoot(host);
 flushSync(()=>tree.render(createElement(CollaborativeTablePage,{page:{id:'table',title:'Commit measurement'},member:{role:'editor',user:{id:'commit-bench'},workspace:{id:'wiki'},features:{}},queryBase:'/linked',onSelectPage(){}})));
 const button=()=>[...host.querySelectorAll('button')].find(item=>item.textContent.trim()==='Refresh');
 const durations=[],refreshLatency=[],queries=[];
 globalThis.__heldReads=[];
 try{
  for(let i=0;i<100&&(!button()||button().disabled);i++)await frame();
  for(let sample=0;sample<20;sample++){
   globalThis.__holdReads=true;globalThis.__committedAt=0;
   const before=globalThis.__requests;let releasedAt=0;
   host.querySelector('input[aria-label="Done"]').click();
   for(let pass=0;pass<100&&!globalThis.__committedAt;pass++)await frame();
   if(!globalThis.__committedAt)throw Error('Mutation did not commit');
   // Controlled application barriers hold the read across two frames, independently of mutation completion.
   for(let pass=0;pass<2;pass++){await frame();if(!button().disabled&&!releasedAt)releasedAt=performance.now();}
   globalThis.__holdReads=false;for(const release of globalThis.__heldReads.splice(0))release();
   for(let pass=0;pass<100;pass++){
    await frame();
    if(!button().disabled&&!releasedAt)releasedAt=performance.now();
    if(releasedAt&&!host.textContent.includes('Saved. Refreshing the latest table data'))break;
   }
   if(!releasedAt)throw Error('Commit busy state did not release');
   durations.push(releasedAt-globalThis.__committedAt);refreshLatency.push(performance.now()-globalThis.__committedAt);queries.push(globalThis.__requests-before-1);
  }
  return {samples:20,p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),refreshP50Ms:percentile(refreshLatency,.5),refreshP95Ms:percentile(refreshLatency,.95),readsPerCommit:queries,heldReadFrames:2};
 }finally{globalThis.__holdReads=false;for(const release of globalThis.__heldReads.splice(0))release();tree.unmount();host.remove();}
};
globalThis.measureReconnect=async()=>{
 const Native=globalThis.WebSocket,times=[],starts=new Map();let queries=0,created=0;
 class Socket extends EventTarget{
  static OPEN=1;static all=[];readyState=1;
  constructor(url){super();this.url=url;Socket.all.push(this);created++;queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'table-ready',generation:1,authorizationRemainingMs:300000,renewalDelayMs:270000})})));}
  send(){} close(){this.readyState=3;this.dispatchEvent(new CloseEvent('close',{code:1000}));}
  fenced(){this.readyState=3;this.dispatchEvent(new CloseEvent('close',{code:4403}));}
 }
 globalThis.WebSocket=Socket;const controllers=[];
 try{
  for(let i=0;i<20;i++){const id='ws://measurement/'+i;controllers.push(tableConnection({url:id,query:async()=>{queries++;const value={generation:1,canEdit:true};return SOCKET_RECEIPT?{state:"complete",value}:value},ready:value=>{if(value&&starts.has(id)){times.push(performance.now()-starts.get(id));starts.delete(id)}}}));}
  await frame();
  const initial=[...Socket.all];for(const socket of initial)starts.set(socket.url,performance.now());
  for(const socket of initial)socket.fenced();
  const deadline=performance.now()+5000;
  while(times.length<20&&performance.now()<deadline)await frame();
  if(times.length!==20)throw Error('Reconnect did not complete');
  const buckets=new Map();for(const ms of times){const bucket=Math.floor(ms/100);buckets.set(bucket,(buckets.get(bucket)??0)+1)}
  return {samples:times.length,p50Ms:percentile(times,.5),p95Ms:percentile(times,.95),maximumReadyIn100ms:Math.max(...buckets.values()),webSockets:created,queries};
 }finally{for(const stop of controllers)stop();globalThis.WebSocket=Native;}
};
`;
async function bundle(before) {
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents: entry.replace(
        "SOCKET_RECEIPT",
        String(
          (before
            ? execFileSync("git", ["show", `${baseline}:src/client/table-connection.ts`], { encoding: "utf8" })
            : await readFile("src/client/table-connection.ts", "utf8")
          ).includes("TableReadReceipt<TableQueryResult>"),
        ),
      ),
      resolveDir: root,
      sourcefile: "collaboration-measurement.mjs",
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    target: "chrome120",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "controlled-collaboration-fixture",
        setup(builder) {
          builder.onLoad({ filter: /src\/client\/api\.ts$/ }, () => ({
            contents: `export class ApiClientError extends Error{}; export const isPageNotFoundError=e=>e instanceof ApiClientError&&e.code==='page_not_found'&&(e.status===404||e.status===410); export const json=JSON.stringify; export const apiErrorMessage=(e,f)=>f; export async function api(path,init){
              globalThis.__requests++;
              if(globalThis.__holdReads&&!init?.method)await new Promise(resolve=>globalThis.__heldReads.push(resolve));
              if(globalThis.__failNextRead&&!init?.method){globalThis.__failNextRead=false;throw Error('Controlled read failure')}
              if(globalThis.__pagedRows&&!init?.method){
                const params=new URL(path,'http://fixture').searchParams,limit=Number(params.get('limit')??100),cursor=params.get('cursor');
                const decoded=cursor?JSON.parse(cursor):{offset:0,limit};
                if(decoded.limit!==limit){const error=new ApiClientError('Changed cursor page size');error.code='table_cursor_stale';throw error;}
                globalThis.__pageQueries.push({limit,cursor});
                const end=decoded.offset+limit;
                return {...globalThis.__data,rows:globalThis.__pagedRows.slice(decoded.offset,end),rowCount:globalThis.__pagedRows.length,nextCursor:end<globalThis.__pagedRows.length?JSON.stringify({offset:end,limit}):null};
              }
              const viewId=new URL(path,'http://fixture').searchParams.get('viewId');
              if(path?.endsWith('/commands')){globalThis.__data={...globalThis.__data,revision:globalThis.__data.revision+1};globalThis.__committedAt=performance.now();return {generation:globalThis.__data.generation,revision:globalThis.__data.revision,result:{},projectionPending:false};}
              return {...globalThis.__data,view:viewId?globalThis.__data.views.find(view=>view.id===viewId)??null:null};
            }`,
            loader: "ts",
          }));
          builder.onLoad({ filter: /src\/client\/realtime-access-status\.ts$/ }, () => ({
            contents: `export const useRealtimeAccessStatus=()=>({account:null});export const useRealtimeAccessAccount=()=>null;export const realtimeAccessAccount=()=>null;export const subscribeRealtimeAccess=()=>()=>{};`,
            loader: "ts",
          }));
          builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
          builder.onLoad({ filter: controlled }, async ({ path }) => {
            let contents = before
              ? execFileSync("git", ["show", `${baseline}:${relative(root, path)}`], { encoding: "utf8" })
              : await readFile(path, "utf8");
            if (path.endsWith("CollaborativeTablePage.tsx"))
              contents = contents.replace(
                "  const base = queryBase",
                "  globalThis.__wholeTableRenders=(globalThis.__wholeTableRenders??0)+1;\n  const base = queryBase",
              );
            if (path.endsWith("comment-publication.ts"))
              contents = contents
                .replace(
                  "set.add(listener);",
                  "globalThis.__receiptSubscriptions=(globalThis.__receiptSubscriptions??0)+1; set.add(listener);",
                )
                .replace(
                  "set.delete(listener);",
                  "globalThis.__receiptUnsubscriptions=(globalThis.__receiptUnsubscriptions??0)+1; set.delete(listener);",
                );
            if (path.endsWith("cell-drafts.ts"))
              contents = contents.replace(
                "function notify(account: string, name?: string) {",
                "function notify(account: string, name?: string) { globalThis.__draftNotifications=(globalThis.__draftNotifications??0)+1;",
              );
            return { contents, loader: path.endsWith("tsx") ? "tsx" : "ts", resolveDir: resolvePath(path, "..") };
          });
        },
      },
    ],
  });
  return result.outputFiles.find((file) => file.path.endsWith(".js") || file.path === "<stdout>").text;
}
const bundles = { baseline: await bundle(true), updated: await bundle(false) };
const server = createServer((request, response) => {
  const mode = request.url?.includes("baseline") ? "baseline" : "updated";
  response.setHeader("Content-Type", request.url?.endsWith(".js") ? "application/javascript" : "text/html");
  response.end(
    request.url?.endsWith(".js")
      ? bundles[mode]
      : `<!doctype html><html><body><script src="/${mode}.js"></script></body></html>`,
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
const results = {
  baselineRevision: baseline,
  updatedRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  harnessRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  command: `NOTES_BENCH_TYPING_EDITS=${typingEdits} NOTES_BENCH_READ_RECOVERY=${measureReadRecovery ? "1" : "0"} node scripts/measure-collaboration-recovery.mjs ${baseline}${output ? ` ${output}` : ""}${corruptStorage ? " --corrupt-storage" : ""}`,
  fixture: {
    readRecoverySamplesPerVersion: measureReadRecovery ? 3 : 0,
    corruptAccountDraft: corruptStorage,
    rows: 100,
    columns: 3,
    accountDrafts: 500,
    unrelatedStorageKeys: 5000,
    typingEditsPerContext: typingEdits,
    contextsPerVersion: 3,
    reconnectingClients: 20,
    readRecoveryRandomDraw: measureReadRecovery ? 0.5 : null,
    paginationRows: 1200,
    paginationVisibleRowsBeforeRefresh: 500,
    paginationRefreshSamplesPerContext: 5,
    queryVerificationSamplesPerContext: 20,
    fulfilledContinuationSamplesPerContext: 1000,
    freshnessCompletionSamplesPerContext: 10,
    invalidationsPerFreshnessSample: 8,
  },
  limits:
    "Local optimized/minified production-React bundle in Chromium; API and table socket transport are controlled fixtures, not production network or D1 latency.",
  runs: {},
};
try {
  for (const mode of ["baseline", "updated"]) {
    results.runs[mode] = [];
    for (let run = 0; run < 3; run++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/${mode}`);
      await page.waitForFunction(() => typeof globalThis.measureTyping === "function");
      results.runs[mode].push({
        typing: await page.evaluate(() => globalThis.measureTyping()),
        receipts: await page.evaluate(() => globalThis.measureReceipts()),
        receiptSubscriptions: await page.evaluate(() => globalThis.measureReceiptSubscriptions()),
        reconnect: await page.evaluate(() => globalThis.measureReconnect()),
        pagination: await page.evaluate(() => globalThis.measurePagination()),
        queryVerification: await page.evaluate(() => globalThis.measureQueryVerification()),
        fulfilledContinuations: await page.evaluate(() => globalThis.measureFulfilledContinuations()),
        viewSwitch: await page.evaluate(() => globalThis.measureViewSwitch()),
        freshnessCompletion: await page.evaluate(() => globalThis.measureFreshnessCompletion()),
        schedulerProgress: await page.evaluate(() => globalThis.measureSchedulerProgress()),
        commitCompletion: await page.evaluate(() => globalThis.measureCommitCompletion()),
        ...(measureReadRecovery ? { readRecovery: await page.evaluate(() => globalThis.measureReadRecovery()) } : {}),
      });
      await context.close();
    }
  }
  const serialized = JSON.stringify(results, null, 2) + "\n";
  if (output) await writeFile(output, serialized);
  process.stdout.write(serialized);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
