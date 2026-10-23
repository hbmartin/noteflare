import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve as resolvePath } from "node:path";

const baseline = process.argv[2] ?? "ac826e9";
const output = process.argv[3];
const root = process.cwd();
const controlled = /src\/client\/(CollaborativeTablePage|CellDraftRecovery|cell-drafts|table-connection)\.(ts|tsx)$/;
const entry = `
import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {CollaborativeTablePage} from './src/client/CollaborativeTablePage';
import {tableConnection} from './src/client/table-connection';
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
  for(let i=0;i<20;i++){const started=performance.now();edit('Measured draft '+i);durations.push(performance.now()-started);}
  if(![...Object.keys(localStorage)].some(key=>localStorage.getItem(key)?.includes('Measured draft 19')))throw Error('No actual persisted input events');
  return {samples:durations.length,p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),counts:{...count,wholeTableRenders:globalThis.__wholeTableRenders},requests:globalThis.__requests};
 }finally{Object.defineProperty(Storage.prototype,'length',descriptor);Storage.prototype.key=key;Storage.prototype.setItem=set;tree.unmount();host.remove();}
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
            contents: `export class ApiClientError extends Error{}; export const json=JSON.stringify; export const apiErrorMessage=(e,f)=>f; export async function api(){globalThis.__requests++;return globalThis.__data;}`,
            loader: "ts",
          }));
          builder.onLoad({ filter: /src\/client\/realtime-access-status\.ts$/ }, () => ({
            contents: `export const useRealtimeAccessStatus=()=>({account:null});export const useRealtimeAccessAccount=()=>null;`,
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
  fixture: {
    rows: 100,
    columns: 3,
    accountDrafts: 500,
    unrelatedStorageKeys: 5000,
    typingEditsPerContext: 20,
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
        reconnect: await page.evaluate(() => globalThis.measureReconnect()),
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
