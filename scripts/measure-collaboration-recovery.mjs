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
  /src\/client\/(CollaborativeTablePage|CellDraftRecovery|cell-drafts|table-connection|comment-publication|linked-table-reads|linked-table-query)\.(ts|tsx)$/;
const entry = `
import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {CollaborativeTablePage} from './src/client/CollaborativeTablePage';
import {tableConnection} from './src/client/table-connection';
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
 }finally{tree.unmount();host.remove();}
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
  for(let i=0;i<20;i++){const id='ws://measurement/'+i;controllers.push(tableConnection({url:id,query:async()=>{queries++;return {generation:1,canEdit:true}},ready:value=>{if(value&&starts.has(id)){times.push(performance.now()-starts.get(id));starts.delete(id)}}}));}
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
    stdin: { contents: entry, resolveDir: root, sourcefile: "collaboration-measurement.mjs" },
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
            contents: `export class ApiClientError extends Error{}; export const json=JSON.stringify; export const apiErrorMessage=(e,f)=>f; export async function api(path,init){globalThis.__requests++;if(globalThis.__failNextRead&&!init?.method){globalThis.__failNextRead=false;throw Error('Controlled read failure')}return path?.endsWith('/commands')?{revision:1,result:{},projectionPending:false}:globalThis.__data;}`,
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
