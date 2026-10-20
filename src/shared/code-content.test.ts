import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as Y from "yjs";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { normalizeCodeBlockContent, normalizeYCodeBlocks } from "./code-content";
import { documentToYjsUpdate } from "./import-content";
import { validateDocumentTree } from "./document-validation";
import type { ProseMirrorJson } from "./types";

const annotation = { threadId: "thread", orphan: false };
function codeDocument(content: ProseMirrorJson[]) {
  return {
    type: "doc",
    content: [
      {
        type: "blockGroup",
        content: [
          {
            type: "blockContainer",
            attrs: { id: "code" },
            content: [{ type: "codeBlock", attrs: { language: "js" }, content }],
          },
        ],
      },
    ],
  };
}
function legacyDocument(content: ProseMirrorJson[]) {
  const document = new Y.Doc();
  Y.applyUpdate(document, documentToYjsUpdate(codeDocument(content)));
  const group = document.getXmlFragment("document-store").get(0) as Y.XmlElement;
  const code = (group.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
  return { document, code };
}

describe("legacy code content normalization", () => {
  it.each(["cjs", "esm"])("keeps the live %s binding usable after rejecting unsupported history", (format) => {
    const imports =
      format === "cjs"
        ? 'const { JSDOM } = require("jsdom"), Y = require("yjs"), { Schema } = require("prosemirror-model"), { EditorState } = require("prosemirror-state"), { EditorView } = require("prosemirror-view"), p = require("y-prosemirror");'
        : 'import { JSDOM } from "jsdom"; import * as Y from "yjs"; import { Schema } from "prosemirror-model"; import { EditorState } from "prosemirror-state"; import { EditorView } from "prosemirror-view"; import * as p from "y-prosemirror";';
    const output = execFileSync(
      process.execPath,
      [
        ...(format === "esm" ? ["--input-type=module"] : []),
        "-e",
        `${imports}
      const dom = new JSDOM('<!doctype html><div id="editor"></div>');
      for (const key of ["window", "document", "MutationObserver", "HTMLElement", "Node", "Element"]) {
        globalThis[key] = key === "window" ? dom.window : key === "document" ? dom.window.document : dom.window[key];
      }
      globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
      const schema = new Schema({ nodes: { doc: { content: "codeBlock+" }, codeBlock: { content: "text*", code: true, toDOM: () => ["pre", ["code", 0]] }, text: {} } });
      const results = [];
      for (const encoded of [false, true]) {
        const doc = new Y.Doc({ gc: false }), root = doc.getXmlFragment("document-store"), code = new Y.XmlElement("codeBlock"), text = new Y.XmlText();
        let view;
        try {
          text.insert(0, "safe"); code.insert(0, [text]); root.insert(0, [code]);
          text.insertEmbed(2, { unsupported: "image" });
          const bad = encoded ? Y.encodeStateAsUpdateV2(doc) : Y.snapshot(doc);
          text.delete(2, 1);
          const clean = encoded ? Y.encodeStateAsUpdateV2(doc) : Y.snapshot(doc);
          const initial = p.initProseMirrorDoc(root, schema), plugin = p.ySyncPlugin(root, { mapping: initial.meta.mapping });
          view = new EditorView(document.querySelector("#editor"), { state: EditorState.create({ schema, doc: initial.doc, plugins: [plugin] }) });
          const binding = p.ySyncPluginKey.getState(view.state).binding;
          view.dispatch(view.state.tr.insertText("before-", 1));
          const before = Buffer.from(Y.encodeStateAsUpdate(doc)), pmBefore = view.state.doc;
          let events = 0, rejected = false;
          const unobserve = p.observeUnsupportedCodeContent(doc, () => events++);
          try { binding._renderSnapshot(clean, bad, p.ySyncPluginKey.getState(view.state)); }
          catch (error) { if (!(error instanceof p.UnsupportedCodeContentError)) throw error; rejected = true; }
          p.assertSupportedCodeContent(root);
          const unchanged = Buffer.from(Y.encodeStateAsUpdate(doc)).equals(before) && view.state.doc.eq(pmBefore);
          const usable = binding.unsupportedCodeContent === null && plugin.props.editable(view.state);
          const stateBeforeExit = view.state;
          binding.unrenderSnapshot();
          const exited = view.state !== stateBeforeExit && p.ySyncPluginKey.getState(view.state).snapshot === null;
          view.dispatch(view.state.tr.insertText("after-", 1));
          results.push({ encoded, rejected, events, unchanged, usable, exited, editable: view.editable, yjs: text.toString(), pm: view.state.doc.textContent });
          unobserve();
        } finally { view?.destroy(); doc.destroy(); }
      }
      dom.window.close(); console.log(JSON.stringify(results));`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(output)).toEqual(
      [false, true].map((encoded) => ({
        encoded,
        rejected: true,
        events: 0,
        unchanged: true,
        usable: true,
        exited: true,
        editable: true,
        yjs: "after-before-safe",
        pm: "after-before-safe",
      })),
    );
  });

  it.each(["cjs", "esm"])("recovers scheduled unsupported snapshot requests in the %s runtime", (format) => {
    const imports =
      format === "cjs"
        ? 'const {JSDOM}=require("jsdom"),Y=require("yjs"),{Schema}=require("prosemirror-model"),{EditorState}=require("prosemirror-state"),{EditorView}=require("prosemirror-view"),p=require("y-prosemirror");'
        : 'import {JSDOM} from "jsdom";import * as Y from "yjs";import {Schema} from "prosemirror-model";import {EditorState} from "prosemirror-state";import {EditorView} from "prosemirror-view";import * as p from "y-prosemirror";';
    const output = execFileSync(
      process.execPath,
      [
        ...(format === "esm" ? ["--input-type=module"] : []),
        "-e",
        `${imports}
      const dom=new JSDOM('<!doctype html><div id="editor"></div>');
      for(const key of ['window','document','MutationObserver','HTMLElement','Node','Element'])globalThis[key]=key==='window'?dom.window:key==='document'?dom.window.document:dom.window[key];
      globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);
      const schema=new Schema({nodes:{doc:{content:'codeBlock+'},codeBlock:{content:'text*',code:true,toDOM:()=>['pre',['code',0]]},text:{}}}),results=[];
      for(const encoded of [false,true])for(const mode of ['preview','restore','valid-preview','valid-restore','superseded','exit','destroy']){
        const doc=new Y.Doc({gc:false}),root=doc.getXmlFragment('document-store'),code=new Y.XmlElement('codeBlock'),text=new Y.XmlText();
        text.insert(0,'old');code.insert(0,[text]);root.insert(0,[code]);const valid=encoded?Y.encodeStateAsUpdateV2(doc):Y.snapshot(doc);text.delete(0,3);text.insert(0,'safe');text.insertEmbed(2,false);
        const bad=encoded?Y.encodeStateAsUpdateV2(doc):Y.snapshot(doc);text.delete(2,1);
        const clean=encoded?Y.encodeStateAsUpdateV2(doc):Y.snapshot(doc),initial=p.initProseMirrorDoc(root,schema),plugin=p.ySyncPlugin(root,{mapping:initial.meta.mapping});
        const view=new EditorView(document.querySelector('#editor'),{state:EditorState.create({schema,doc:initial.doc,plugins:[plugin]})});
        let liveErrors=0,historyErrors=0,unexpected=0;
        const unlive=p.observeUnsupportedCodeContent(doc,()=>liveErrors++),unhistory=p.observeUnsupportedSnapshotContent(doc,()=>historyErrors++);
        const manager=new Y.UndoManager(root,{trackedOrigins:new Set([p.ySyncPluginKey]),captureTimeout:0});
        const before=Buffer.from(Y.encodeStateAsUpdate(doc)),callbacks=[],original=setTimeout;
        try{
          globalThis.setTimeout=(fn,ms,...args)=>ms===0?(callbacks.push(()=>fn(...args)),0):original(fn,ms,...args);
          const restore=mode==='restore'||mode==='valid-restore',validHistory=mode.startsWith('valid-');
          view.dispatch(view.state.tr.setMeta(p.ySyncPluginKey,{snapshot:validHistory?valid:restore?bad:clean,prevSnapshot:validHistory?valid:bad,...(restore?{restore:true}:{})}));
          if(mode==='superseded')view.dispatch(view.state.tr.setMeta(p.ySyncPluginKey,{snapshot:clean,prevSnapshot:clean}));
          if(mode==='exit')p.ySyncPluginKey.getState(view.state).binding.unrenderSnapshot();
          if(mode==='destroy')view.destroy();
          for(const callback of callbacks){try{callback();}catch(error){unexpected++;}}
        }finally{globalThis.setTimeout=original;}
        const state=p.ySyncPluginKey.getState(view.state),retained=mode==='superseded'||mode==='valid-preview';
        results.push({encoded,mode,liveErrors,historyErrors,unexpected,unchanged:before.equals(Buffer.from(Y.encodeStateAsUpdate(doc))),snapshotRetained:state.snapshot!=null,restoreRetained:state.restore===true,undoEntries:manager.undoStack.length});
        if(mode!=='destroy'){
          if(retained)state.binding.unrenderSnapshot();
          if(!view.editable)throw new Error('Live editor stayed read-only');
          view.dispatch(view.state.tr.insertText('after-',1));
          if(text.toString()!==(mode==='valid-restore'?'after-old':'after-safe'))throw new Error('Live document no longer editable');
          view.destroy();
        }
        unlive();unhistory();manager.destroy();doc.destroy();
      }
      dom.window.close();console.log(JSON.stringify(results));`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(output)).toEqual(
      [false, true].flatMap((encoded) =>
        ["preview", "restore", "valid-preview", "valid-restore", "superseded", "exit", "destroy"].map((mode) => ({
          encoded,
          mode,
          liveErrors: 0,
          historyErrors: ["preview", "restore"].includes(mode) ? 1 : 0,
          unexpected: 0,
          unchanged: mode !== "valid-restore",
          snapshotRetained: ["superseded", "valid-preview", "destroy"].includes(mode),
          restoreRetained: false,
          undoEntries: mode === "valid-restore" ? 1 : 0,
        })),
      ),
    );
  });

  it.each(["cjs", "esm"])("retains rejected validation across repeated %s reads", (format) => {
    const imports =
      format === "cjs"
        ? `const fs=require('node:fs'),M=require('node:module'),path=require('node:path'),Y=require('yjs'),{Schema}=require('prosemirror-model'),filename=require.resolve('y-prosemirror'),pkg=new M(filename,module);pkg.filename=filename;pkg.paths=M._nodeModulePaths(path.dirname(filename));pkg._compile(fs.readFileSync(filename,'utf8')+';exports.readCode=createNodeFromYElement;',filename);const p=pkg.exports,readCode=p.readCode;`
        : `import * as Y from 'yjs';import {Schema} from 'prosemirror-model';import * as p from 'y-prosemirror';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import path from 'node:path';const require=createRequire(import.meta.url),{createNodeFromYElement:readCode}=await import(pathToFileURL(path.resolve(path.dirname(require.resolve('y-prosemirror')),'../src/plugins/sync-plugin.js')));`;
    const output = execFileSync(
      process.execPath,
      [
        ...(format === "esm" ? ["--input-type=module"] : []),
        "-e",
        `${imports}
      const schema=new Schema({nodes:{doc:{content:'codeBlock+'},codeBlock:{content:'text*'},text:{}}}),results=[];
      for(const initialFull of [false,true]){
        const doc=new Y.Doc(),root=doc.getXmlFragment('document-store'),code=new Y.XmlElement('codeBlock'),text=new Y.XmlText();text.insert(0,'safe');code.insert(0,[text]);root.insert(0,[code]);
        const initial=p.initProseMirrorDoc(root,schema),binding=new p.ProsemirrorBinding(root,initial.meta.mapping);
        // Isolate the retained reader cache from the separate live-error latch.
        binding.beforeAllTransactions=()=>{};binding._observeFunction=()=>{};binding.initView({});if(!initialFull)binding._checkCodeContent(root);
        text.insertEmbed(2,false);const before=Buffer.from(Y.encodeStateAsUpdate(doc)),errors=[];
        for(let attempt=0;attempt<3;attempt++){try{readCode(code,schema,binding);errors.push(null);}catch(error){errors.push(error.code);}}
        results.push({initialFull,errors,unchanged:before.equals(Buffer.from(Y.encodeStateAsUpdate(doc))),length:text.length});binding.destroy();doc.destroy();
      }console.log(JSON.stringify(results));`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(output)).toEqual(
      [false, true].map((initialFull) => ({
        initialFull,
        errors: Array(3).fill("unsupported_code_content"),
        unchanged: true,
        length: 5,
      })),
    );
  });

  it.each(["cjs", "esm"])("preserves pending restore intent through remote updates in %s", (format) => {
    const imports =
      format === "cjs"
        ? 'const {JSDOM}=require("jsdom"),Y=require("yjs"),{Schema}=require("prosemirror-model"),{EditorState}=require("prosemirror-state"),{EditorView}=require("prosemirror-view"),p=require("y-prosemirror");'
        : 'import {JSDOM} from "jsdom";import * as Y from "yjs";import {Schema} from "prosemirror-model";import {EditorState} from "prosemirror-state";import {EditorView} from "prosemirror-view";import * as p from "y-prosemirror";';
    const output = execFileSync(
      process.execPath,
      [
        ...(format === "esm" ? ["--input-type=module"] : []),
        "-e",
        `${imports}
      const dom=new JSDOM('<!doctype html><div id="editor"></div>');for(const key of ['window','document','MutationObserver','HTMLElement','Node','Element'])globalThis[key]=key==='window'?dom.window:key==='document'?dom.window.document:dom.window[key];globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);
      const schema=new Schema({nodes:{doc:{content:'codeBlock+'},codeBlock:{content:'text*',code:true,toDOM:()=>['pre',['code',0]]},text:{}}}),results=[];
      for(const encoded of [false,true])for(const updates of [1,3])for(const mode of ['restore','preview','exit','destroy']){
        const doc=new Y.Doc({gc:false}),root=doc.getXmlFragment('document-store'),code=new Y.XmlElement('codeBlock'),text=new Y.XmlText();text.insert(0,'old');code.insert(0,[text]);root.insert(0,[code]);const old=encoded?Y.encodeStateAsUpdateV2(doc):Y.snapshot(doc);text.delete(0,3);text.insert(0,'live');
        const initial=p.initProseMirrorDoc(root,schema),plugin=p.ySyncPlugin(root,{mapping:initial.meta.mapping}),view=new EditorView(document.querySelector('#editor'),{state:EditorState.create({schema,doc:initial.doc,plugins:[plugin]})}),binding=p.ySyncPluginKey.getState(view.state).binding;
        const manager=new Y.UndoManager(root,{trackedOrigins:new Set([p.ySyncPluginKey]),captureTimeout:0}),peer=new Y.Doc({gc:false});Y.applyUpdate(peer,Y.encodeStateAsUpdate(doc));
        const callbacks=[],original=setTimeout;let renders=0;const render=binding._renderSnapshot.bind(binding);binding._renderSnapshot=(...args)=>{renders++;return render(...args);};
        globalThis.setTimeout=(fn,ms,...args)=>ms===0?(callbacks.push(()=>fn(...args)),0):original(fn,ms,...args);
        try{
          view.dispatch(view.state.tr.setMeta(p.ySyncPluginKey,{snapshot:old,prevSnapshot:old,restore:true}));
          for(let update=0;update<updates;update++){peer.getXmlFragment('document-store').get(0).get(0).insert(0,'x');Y.applyUpdate(doc,Y.encodeStateAsUpdate(peer),'peer');}
          if(mode==='preview')binding.renderSnapshot(old,old);if(mode==='exit')binding.unrenderSnapshot();if(mode==='destroy')view.destroy();
          for(let index=0;index<callbacks.length;index++){if(index>20)throw new Error('Unbounded snapshot scheduling');callbacks[index]();}
        }finally{globalThis.setTimeout=original;}
        const state=p.ySyncPluginKey.getState(view.state);results.push({encoded,updates,mode,renders,text:text.toString(),preview:state.snapshot!=null,restore:state.restore!=null,undo:manager.undoStack.length,editable:mode==='destroy'?null:view.editable});
        if(mode!=='destroy')view.destroy();manager.destroy();peer.destroy();doc.destroy();
      }dom.window.close();console.log(JSON.stringify(results));`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(output)).toEqual(
      [false, true].flatMap((encoded) =>
        [1, 3].flatMap((updates) =>
          ["restore", "preview", "exit", "destroy"].map((mode) => ({
            encoded,
            updates,
            mode,
            renders: ["restore", "preview"].includes(mode) ? 1 : 0,
            text: mode === "restore" ? "old" : "x".repeat(updates) + "live",
            preview: ["preview", "destroy"].includes(mode),
            restore: mode === "destroy",
            undo: mode === "restore" ? 1 : 0,
            editable: mode === "destroy" ? null : mode !== "preview",
          })),
        ),
      ),
    );
  });

  it.each(["cjs", "esm"])("seeds %s cursors without scanning historical structs before full validation", (format) => {
    const imports =
      format === "cjs"
        ? 'const Y=require("yjs"),{Schema}=require("prosemirror-model"),p=require("y-prosemirror");'
        : 'import * as Y from "yjs";import {Schema} from "prosemirror-model";import * as p from "y-prosemirror";';
    const output = execFileSync(
      process.execPath,
      [
        ...(format === "esm" ? ["--input-type=module"] : []),
        "-e",
        `${imports}
      const schema=new Schema({nodes:{doc:{content:'codeBlock+'},codeBlock:{content:'text*'},text:{}}}),results=[];
      for(const count of [100,1000,10000]){
        const doc=new Y.Doc({gc:false}),root=doc.getXmlFragment('document-store'),code=new Y.XmlElement('codeBlock'),text=new Y.XmlText();
        text.insert(0,'safe');code.insert(0,[text]);root.insert(0,[code]);
        for(let index=0;index<count;index++){const item=new Y.XmlElement('paragraph');root.insert(0,[item]);root.delete(0,1);}
        let reads=0;
        for(const [client,structs] of doc.store.clients)doc.store.clients.set(client,new Proxy(structs,{get(target,key){if(typeof key==='string'&&/^\\d+$/.test(key))reads++;return Reflect.get(target,key);}}));
        const start=performance.now(),pm=p.initProseMirrorDoc(root,schema).doc,ms=performance.now()-start;
        results.push({count,reads,content:pm.textContent,ms});doc.destroy();
      }
      console.log(JSON.stringify(results));`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    const results = JSON.parse(output) as Array<{ count: number; reads: number; content: string; ms: number }>;
    expect(results.map(({ count, reads, content }) => ({ count, reads, content }))).toEqual(
      [100, 1000, 10000].map((count) => ({ count, reads: 1, content: "safe" })),
    );
    expect(results.every((result) => Number.isFinite(result.ms))).toBe(true);
  });

  it.each(["cjs", "esm"])("validates linearly while the %s reader merges adjacent paragraph texts", (format) => {
    const imports =
      format === "cjs"
        ? 'const Y=require("yjs"),{Schema}=require("prosemirror-model"),p=require("y-prosemirror");'
        : 'import * as Y from "yjs";import {Schema} from "prosemirror-model";import * as p from "y-prosemirror";';
    const output = execFileSync(
      process.execPath,
      [
        ...(format === "esm" ? ["--input-type=module"] : []),
        "-e",
        `${imports}
      const schema=new Schema({nodes:{doc:{content:"block+"},paragraph:{content:"text*",group:"block"},codeBlock:{content:"text*",group:"block"},text:{}}});
      const results=[];
      for(const count of [50,100,200]) {
        const doc=new Y.Doc(),root=doc.getXmlFragment("document-store");let reads=0;
        doc.transact(()=>{for(let index=0;index<count;index++) {
          const paragraph=new Y.XmlElement("paragraph");paragraph.insert(0,["left","right"].map(value=>{const text=new Y.XmlText();text.insert(0,value);return text;}));
          const code=new Y.XmlElement("codeBlock"),text=new Y.XmlText();text.insert(0,"safe");code.insert(0,[text]);root.insert(root.length,[paragraph,code]);
          const delta=text.toDelta.bind(text);text.toDelta=(...args)=>{reads++;return delta(...args)};
        }});
        const pm=p.initProseMirrorDoc(root,schema).doc;
        results.push({count,reads,paragraph:pm.firstChild.textContent,blocks:pm.childCount});doc.destroy();
      }
      console.log(JSON.stringify(results));`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(output)).toEqual(
      [50, 100, 200].map((count) => ({ count, reads: 2 * count, paragraph: "leftright", blocks: 2 * count })),
    );
  });

  it.each(["cjs", "esm"])("avoids repeated historical client scans in the %s reader", (format) => {
    const imports =
      format === "cjs"
        ? 'const Y=require("yjs"),{Schema}=require("prosemirror-model"),p=require("y-prosemirror");'
        : 'import * as Y from "yjs";import {Schema} from "prosemirror-model";import * as p from "y-prosemirror";';
    const output = execFileSync(
      process.execPath,
      [
        ...(format === "esm" ? ["--input-type=module"] : []),
        "-e",
        `${imports}
      const schema=new Schema({nodes:{doc:{content:"paragraph+"},paragraph:{content:"text*"},text:{}}}), results=[];
      for (const count of [50,200,800]) {
        const doc=new Y.Doc(),root=doc.getXmlFragment("document-store");doc.clientID=1;
        doc.transact(()=>{for(let index=0;index<count;index++) {
          const paragraph=new Y.XmlElement("paragraph"),text=new Y.XmlText();text.insert(0,"safe");paragraph.insert(0,[text]);root.insert(root.length,[paragraph]);
        }});
        for(let index=1;index<1000;index++) {
          const peer=new Y.Doc();peer.clientID=200000+index;peer.getMap("presence").set(String(index),index);
          Y.applyUpdate(doc,Y.encodeStateAsUpdate(peer));peer.destroy();
        }
        let scans=0,visits=0;const entries=doc.store.clients[Symbol.iterator].bind(doc.store.clients);
        doc.store.clients[Symbol.iterator]=function*(){scans++;for(const entry of entries()){visits++;yield entry;}};
        const pm=p.initProseMirrorDoc(root,schema).doc;
        results.push({count,scans,visits,blocks:pm.childCount});doc.destroy();
      }
      console.log(JSON.stringify(results));`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(output)).toEqual(
      [50, 200, 800].map((count) => ({ count, scans: 1, visits: 1000, blocks: count })),
    );
  });

  it.each(["cjs", "esm"])("detects mutations inside an open transaction during the %s reader", (format) => {
    const imports =
      format === "cjs"
        ? 'const Y=require("yjs"),{Schema}=require("prosemirror-model"),p=require("y-prosemirror");'
        : 'import * as Y from "yjs";import {Schema} from "prosemirror-model";import * as p from "y-prosemirror";';
    const output = execFileSync(
      process.execPath,
      [
        ...(format === "esm" ? ["--input-type=module"] : []),
        "-e",
        `${imports}
      const schema=new Schema({nodes:{doc:{content:"paragraph codeBlock"},paragraph:{content:"text*"},codeBlock:{content:"text*"},text:{}}});
      const doc=new Y.Doc(),root=doc.getXmlFragment("document-store"),paragraph=new Y.XmlElement("paragraph"),plain=new Y.XmlText(),code=new Y.XmlElement("codeBlock"),text=new Y.XmlText();
      plain.insert(0,"plain");paragraph.insert(0,[plain]);text.insert(0,"safe");code.insert(0,[text]);root.insert(0,[paragraph,code]);
      const attributes=paragraph.getAttributes.bind(paragraph);let injected=false,rejected=false;
      // A descendant read mutates a later code block after root preflight, while
      // the existing transaction suppresses a second beforeTransaction event.
      paragraph.getAttributes=(...args)=>{if(!injected){injected=true;text.insertEmbed(0,false);}return attributes(...args);};
      try {doc.transact(()=>p.initProseMirrorDoc(root,schema));}
      catch(error) {if(!(error instanceof p.UnsupportedCodeContentError))throw error;rejected=true;}
      console.log(JSON.stringify({injected,rejected,retained:text.toDelta().some(delta=>delta.insert===false)}));doc.destroy();`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(output)).toEqual({ injected: true, rejected: true, retained: true });
  });

  it.each(["cjs", "esm"])("invalidates an active unbound %s preflight after observer mutations", (format) => {
    const imports =
      format === "cjs"
        ? 'const Y = require("yjs"), { Schema } = require("prosemirror-model"), p = require("y-prosemirror");'
        : 'import * as Y from "yjs"; import { Schema } from "prosemirror-model"; import * as p from "y-prosemirror";';
    const output = execFileSync(
      process.execPath,
      [
        ...(format === "esm" ? ["--input-type=module"] : []),
        "-e",
        `${imports}
      const schema = new Schema({ nodes: { doc: { content: "paragraph codeBlock" }, paragraph: { content: "text*" }, codeBlock: { content: "text*" }, text: {} } });
      const doc = new Y.Doc(), root = doc.getXmlFragment("document-store"), paragraph = new Y.XmlElement("paragraph"), code = new Y.XmlElement("codeBlock"), text = new Y.XmlText();
      const paragraphTexts = ["left", "right"].map(value => { const part = new Y.XmlText(); part.insert(0, value); return part; });
      paragraph.insert(0, paragraphTexts); text.insert(0, "safe code"); code.insert(0, [text]); root.insert(0, [paragraph, code]);
      let injected = false;
      root.observeDeep(() => { if (!injected) { injected = true; text.insertEmbed(2, false); } });
      const observers = () => [...doc._observers.values()].reduce((sum, listeners) => sum + listeners.size, 0), count = observers();
      let rejected = false;
      try { p.initProseMirrorDoc(root, schema); } catch (error) { if (!(error instanceof p.UnsupportedCodeContentError)) throw error; rejected = true; }
      console.log(JSON.stringify({ injected, rejected, retained: code.get(0) === text && text.toDelta().some(delta => delta.insert === false), observersCleaned: observers() === count }));
      doc.destroy();`,
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({ injected: true, rejected: true, retained: true, observersCleaned: true });
  });

  it.each(["cjs", "esm"])("shares recursive preflight and invalidates binding scopes in the %s patch", (format) => {
    const imports =
      format === "cjs"
        ? 'const Y = require("yjs"), { Schema } = require("prosemirror-model"), p = require("y-prosemirror");'
        : 'import * as Y from "yjs"; import { Schema } from "prosemirror-model"; import * as p from "y-prosemirror";';
    const output = execFileSync(
      process.execPath,
      [
        ...(format === "esm" ? ["--input-type=module"] : []),
        "-e",
        `${imports}
      const schema = new Schema({ nodes: { doc: { content: "section" }, section: { content: "block+" }, paragraph: { content: "text*", group: "block" }, codeBlock: { content: "text*", group: "block" }, text: {} } });
      const doc = new Y.Doc(), root = doc.getXmlFragment("document-store"), section = new Y.XmlElement("section"), paragraph = new Y.XmlElement("paragraph"), plain = new Y.XmlText();
      paragraph.insert(0, [plain]); section.insert(0, [paragraph]); root.insert(0, [section]);
      const counts = Array(100).fill(0), texts = counts.map((_, index) => {
        const text = new Y.XmlText(), code = new Y.XmlElement("codeBlock"); text.insert(0, "code"); code.insert(0, [text]); section.insert(section.length, [code]);
        const delta = text.toDelta.bind(text); text.toDelta = (...args) => { counts[index]++; return delta(...args); }; return text;
      });
      const result = {}, inspect = () => [Math.min(...counts), Math.max(...counts)], reset = () => counts.fill(0);
      const { doc: pm, meta } = p.initProseMirrorDoc(root, schema); result.initialReader = inspect(); reset();
      p.updateYFragment(doc, root, pm, meta); result.unboundWriter = inspect(); reset();
      const observers = () => [...doc._observers.values()].reduce((sum, listeners) => sum + listeners.size, 0), originalObservers = observers();
      const binding = new p.ProsemirrorBinding(root, meta.mapping);
      // Keep a real mounted binding and real Yjs observers; rendering itself is
      // separately exercised by the BlockNote two-editor tests.
      binding.beforeAllTransactions = () => {};
      binding._observeFunction = () => binding._checkCodeContent(root);
      binding.initView({}); binding._checkCodeContent(root); result.bindingStartup = inspect(); reset();
      plain.insert(0, "paragraph"); doc.getMap("presence").set("cursor", 1); result.unrelated = inspect(); reset();
      texts[0].insert(1, "!"); result.changedCode = [counts[0], ...inspect().slice(0, 1), Math.max(...counts.slice(1))]; reset();
      const added = new Y.XmlElement("paragraph"); section.insert(section.length, [added]); result.structural = inspect(); reset();
      doc.emit("beforeObserverCalls", [{ changed: new Map([[new Y.XmlFragment(), new Set([null])]]) }, doc]);
      binding._checkCodeContent(root); result.unknown = inspect(); reset();
      binding.destroy(); result.observersRetained = observers() === originalObservers;
      console.log(JSON.stringify(result)); doc.destroy();`,
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({
      initialReader: [2, 2],
      unboundWriter: [1, 1],
      bindingStartup: [1, 1],
      unrelated: [0, 0],
      changedCode: [1, 0, 0],
      structural: [0, 0],
      unknown: [1, 1],
      observersRetained: true,
    });
  });

  it.each(["cjs", "esm"])("uses consistent snapshot preflight modes in the %s patch", (format) => {
    const imports =
      format === "cjs"
        ? 'const Y = require("yjs"), p = require("y-prosemirror");'
        : 'import * as Y from "yjs"; import * as p from "y-prosemirror";';
    const output = execFileSync(
      process.execPath,
      [
        ...(format === "esm" ? ["--input-type=module"] : []),
        "-e",
        `${imports}
      const doc = new Y.Doc({ gc: false }), root = doc.getXmlFragment("document-store"), code = new Y.XmlElement("codeBlock");
      const texts = ["left", "", "right"].map(value => { const text = new Y.XmlText(); text.insert(0, value); return text; });
      texts[0].format(0, 4, { "comment--0123abcd": { threadId: "thread", orphan: false } });
      code.insert(0, texts); root.insert(0, [code]);
      texts[0].insertEmbed(2, { unsupported: "image" });
      const bad = Y.snapshot(doc); texts[0].delete(2, 1); const clean = Y.snapshot(doc);
      const results = [];
      const check = (name, args, rejected) => {
        const before = Buffer.from(Y.encodeStateAsUpdate(doc));
        try { p.assertSupportedCodeContent(root, ...args); if (rejected) throw Error("Expected rejection: " + name); }
        catch (error) { if (!rejected || !(error instanceof p.UnsupportedCodeContentError)) throw error; }
        if (!Buffer.from(Y.encodeStateAsUpdate(doc)).equals(before)) throw Error("Preflight changed shared bytes");
        if (code.length !== texts.length || texts.some((text, index) => code.get(index) !== text)) throw Error("Preflight changed text identities");
        results.push(name);
      };
      check("live", [], false);
      check("snapshot-only", [bad], false);
      check("previous-only", [undefined, bad], false);
      check("clean-history", [clean, clean], false);
      check("invalid-history", [clean, bad], true);
      const atom = new Y.XmlElement("hardBreak"); code.insert(1, [atom]); const atomHistory = Y.snapshot(doc); code.delete(1, 1);
      check("deleted-child-live", [], false);
      check("deleted-child-snapshot-only", [atomHistory], false);
      check("deleted-child-previous-only", [undefined, atomHistory], false);
      check("invalid-child-history", [Y.snapshot(doc), atomHistory], true);
      texts[2].insertEmbed(2, { unsupported: "image" });
      check("invalid-live", [], true);
      check("invalid-live-snapshot-only", [clean], true);
      check("invalid-live-previous-only", [undefined, clean], true);
      check("clean-history-with-invalid-live", [clean, clean], false);
      console.log(JSON.stringify({ results, commentKeys: Object.keys(texts[0].toDelta()[0].attributes), emptySegment: texts[1].length }));
      doc.destroy();`,
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({
      results: [
        "live",
        "snapshot-only",
        "previous-only",
        "clean-history",
        "invalid-history",
        "deleted-child-live",
        "deleted-child-snapshot-only",
        "deleted-child-previous-only",
        "invalid-child-history",
        "invalid-live",
        "invalid-live-snapshot-only",
        "invalid-live-previous-only",
        "clean-history-with-invalid-live",
      ],
      commentKeys: ["comment--0123abcd"],
      emptySegment: 0,
    });
  });

  it.each(["cjs", "esm"])(
    "preflights unsupported code before the %s reader or writer changes shared content",
    (format) => {
      const imports =
        format === "cjs"
          ? 'const Y = require("yjs"), { Schema } = require("prosemirror-model"), p = require("y-prosemirror");'
          : 'import * as Y from "yjs"; import { Schema } from "prosemirror-model"; import * as p from "y-prosemirror";';
      const output = execFileSync(
        process.execPath,
        [
          ...(format === "esm" ? ["--input-type=module"] : []),
          "-e",
          `${imports}
      const schema = new Schema({ nodes: { doc: { content: "paragraph codeBlock" }, paragraph: { content: "text*", attrs: { id: { default: "original" } } }, codeBlock: { content: "text*", attrs: { language: { default: "js" } } }, text: {} } });
      const doc = new Y.Doc(), fragment = doc.getXmlFragment("document-store"), paragraph = new Y.XmlElement("paragraph"), code = new Y.XmlElement("codeBlock");
      const head = new Y.XmlText(), tail = new Y.XmlText(); head.insert(0, "left"); tail.insert(0, "right");
      paragraph.insert(0, [new Y.XmlText()]); code.insert(0, [head, tail]); code.setAttribute("language", "js"); fragment.insert(0, [paragraph, code]);
      const { meta } = p.initProseMirrorDoc(fragment, schema);
      // An earlier paragraph would be merged by the upstream reader. An earlier
      // attribute/text would be changed by the writer without root preflight.
      const owned = new Y.XmlText(); owned.insert(0, "owned"); paragraph.insert(1, [owned]);
      tail.insertEmbed(2, { unsupported: "image" });
      const before = Buffer.from(Y.encodeStateAsUpdate(doc)), mappings = [...meta.mapping.entries()];
      const desired = schema.node("doc", null, [schema.node("paragraph", { id: "changed" }, [schema.text("changed")]), schema.node("codeBlock", { language: "python" }, [schema.text("replacement")])]);
      const attempts = [
        () => p.assertSupportedCodeContent(fragment),
        () => p.initProseMirrorDoc(fragment, schema),
        () => p.yXmlFragmentToProseMirrorRootNode(fragment, schema),
        () => p.updateYFragment(doc, fragment, desired, meta),
      ];
      const errors = attempts.map(attempt => { try { attempt(); throw Error("Expected rejection"); } catch (error) { if (!(error instanceof p.UnsupportedCodeContentError)) throw error; return error.code; } });
      if (!Buffer.from(Y.encodeStateAsUpdate(doc)).equals(before)) throw Error("Shared bytes changed");
      if (paragraph.length !== 2 || code.get(1) !== tail || paragraph.getAttribute("id") !== undefined || code.getAttribute("language") !== "js") throw Error("Shared identities or attributes changed");
      if (mappings.length !== meta.mapping.size || mappings.some(([key, value]) => meta.mapping.get(key) !== value)) throw Error("Mapping changed before preflight");
      const observers = () => [...doc._observers.values()].reduce((sum, listeners) => sum + listeners.size, 0), count = observers();
      const plugin = p.ySyncPlugin(fragment, { mapping: meta.mapping });
      try { plugin.spec.view({ state: { schema } }); throw Error("Expected initial rejection"); } catch (error) { if (!(error instanceof p.UnsupportedCodeContentError)) throw error; }
      if (observers() !== count || fragment._dEH.l.length) throw Error("Failed mount leaked observers");
      if (!Buffer.from(Y.encodeStateAsUpdate(doc)).equals(before)) throw Error("Failed mount changed bytes");
      console.log(JSON.stringify({ errors, identitiesRetained: true, observersCleaned: true }));
      doc.destroy();`,
        ],
        { encoding: "utf8" },
      );
      expect(JSON.parse(output)).toEqual({
        errors: Array(4).fill("unsupported_code_content"),
        identitiesRetained: true,
        observersCleaned: true,
      });
    },
  );

  it("uses the persisted CJS patch to preserve same-thread aliases within one text and across texts", () => {
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        `
      const Y = require("yjs"), { Schema } = require("prosemirror-model"), p = require("y-prosemirror");
      const schema = new Schema({ nodes: { doc: { content: "codeBlock+" }, codeBlock: { content: "text*" }, text: {} }, marks: { comment: { attrs: { threadId: { default: "" }, orphan: { default: false } }, excludes: "" } } });
      const results = [];
      for (const single of [false, true]) {
        const doc = new Y.Doc(), code = new Y.XmlElement("codeBlock"), attrs = { threadId: "same-thread", orphan: false };
        const runs = [{ insert: "left", attributes: { comment: attrs } }, { insert: "right", attributes: { "comment--0123abcd": attrs } }];
        const texts = single ? [new Y.XmlText()] : [new Y.XmlText(), new Y.XmlText()];
        if (single) texts[0].applyDelta(runs); else runs.forEach((run, index) => texts[index].applyDelta([run]));
        code.insert(0, texts); doc.getXmlFragment("document-store").insert(0, [code]);
        const { doc: pm, meta } = p.initProseMirrorDoc(doc.getXmlFragment("document-store"), schema);
        p.updateYFragment(doc, doc.getXmlFragment("document-store"), schema.node("doc", null, [schema.node("codeBlock", null, [schema.text("leXftright", pm.firstChild.firstChild.marks)])]), meta);
        results.push({ text: texts.map(text => text.toDelta().map(delta => delta.insert).join("")).join(""), keys: texts.flatMap(text => text.toDelta().flatMap(delta => Array.from({ length: delta.insert.length }, () => Object.keys(delta.attributes || {}).sort()))), identity: code.toArray().every((text, index) => text === texts[index]) });
      }
      console.log(JSON.stringify(results));
    `,
      ],
      { encoding: "utf8" },
    );
    for (const result of JSON.parse(output)) {
      expect(result.text).toBe("leXftright");
      expect(result.keys).toEqual([
        ...Array.from({ length: 5 }, () => ["comment"]),
        ...Array.from({ length: 5 }, () => ["comment--0123abcd"]),
      ]);
      expect(result.identity).toBe(true);
    }
  });
  it("uses the persisted CJS reader/writer patch when reconciling concurrent segmented code", () => {
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        `
      const Y = require("yjs"), { Schema } = require("prosemirror-model"), p = require("y-prosemirror");
      const schema = new Schema({ nodes: { doc: { content: "codeBlock+" }, codeBlock: { content: "text*" }, text: {} } });
      const seed = new Y.Doc(), code = new Y.XmlElement("codeBlock");
      const texts = ["left", "\\n", "right"].map(value => { const text = new Y.XmlText(); text.insert(0, value); return text; });
      code.insert(0, texts); seed.getXmlFragment("document-store").insert(0, [code]);
      p.initProseMirrorDoc(seed.getXmlFragment("document-store"), schema);
      if (code.length !== 3) throw Error("Reader moved text identity");
      const bytes = Y.encodeStateAsUpdate(seed), docs = [new Y.Doc(), new Y.Doc()];
      for (const [index, doc] of docs.entries()) {
        Y.applyUpdate(doc, bytes);
        const fragment = doc.getXmlFragment("document-store"), { doc: pm, meta } = p.initProseMirrorDoc(fragment, schema);
        p.updateYFragment(doc, fragment, schema.node("doc", null, [schema.node("codeBlock", null, [schema.text(pm.textContent + (index ? " B" : " A"))])]), meta);
      }
      Y.applyUpdate(docs[0], Y.encodeStateAsUpdate(docs[1]));
      console.log(JSON.stringify({ text: p.yXmlFragmentToProseMirrorRootNode(docs[0].getXmlFragment("document-store"), schema).textContent, types: docs[0].getXmlFragment("document-store").get(0).length }));
    `,
      ],
      { encoding: "utf8" },
    );
    const result = JSON.parse(output);
    expect(result.text).toMatch(/^left\nright (A B|B A)$/);
    expect(result.types).toBe(3);
  });
  it("preserves whitespace and both comment forms while stripping only known formatting and converting breaks", () => {
    const content = [
      {
        type: "text",
        text: "  const 😀 = 1;",
        marks: [
          { type: "bold" },
          { type: "link", attrs: { href: "https://example.test" } },
          { type: "comment", attrs: annotation },
          { type: "comment--legacy_thread", attrs: { ...annotation, threadId: "legacy" } },
        ],
      },
      { type: "hardBreak", marks: [{ type: "comment", attrs: annotation }] },
      { type: "text", text: "\tend\n" },
    ];
    const normalized = normalizeCodeBlockContent(content);
    expect(normalized).toEqual([
      {
        type: "text",
        text: "  const 😀 = 1;",
        marks: [
          { type: "comment", attrs: annotation },
          { type: "comment--legacy_thread", attrs: { ...annotation, threadId: "legacy" } },
        ],
      },
      { type: "text", text: "\n", marks: [{ type: "comment", attrs: annotation }] },
      { type: "text", text: "\tend\n" },
    ]);
    expect(content[0]!.marks).toHaveLength(4);
    validateDocumentTree(codeDocument(normalized));
    expect(normalizeCodeBlockContent(normalized)).toEqual(normalized);
  });

  it.each([
    { type: "mention", attrs: { label: "Do not guess my text" } },
    { type: "hardBreak", content: [{ type: "text", text: "hidden" }] },
    { type: "hardBreak", text: "hidden" },
    { type: "hardBreak", attrs: { label: "Do not discard me" } },
    { type: "text", text: "" },
    { type: "text", text: "text", attrs: { invalid: {} } },
    { type: "text", text: "text", marks: [{ type: "bold", attrs: { invalid: {} } }] },
    { type: "text", text: "text", marks: [{ type: "comment", attrs: { threadId: 1 } }] },
    { type: "text", text: "text", marks: [{ type: "unknown" }] },
  ])("rejects unsupported or malformed code content: %j", (node) => {
    expect(() => normalizeCodeBlockContent([node])).toThrow(/unsupported|invalid|unknown/);
  });

  it("keeps XmlText identity, relative anchors and raw annotations, and emits no update after the repair", () => {
    const { document, code } = legacyDocument([
      {
        type: "text",
        text: "  😀first",
        marks: [
          { type: "bold" },
          { type: "comment--0123abcd", attrs: annotation },
          { type: "comment--legacy_thread", attrs: annotation },
        ],
      },
      { type: "hardBreak" },
      { type: "text", text: "\tsecond\n", marks: [{ type: "textColor", attrs: { stringValue: "red" } }] },
    ]);
    const first = code.get(0) as Y.XmlText,
      last = code.get(2) as Y.XmlText;
    const outside = new Y.XmlElement("paragraph"),
      outsideText = new Y.XmlText();
    outsideText.insert(0, "Styled outside code");
    outsideText.format(0, 19, { bold: {} });
    outside.insert(0, [outsideText]);
    const outsideContainer = new Y.XmlElement("blockContainer");
    outsideContainer.setAttribute("id", "outside");
    outsideContainer.insert(0, [outside]);
    (document.getXmlFragment("document-store").get(0) as Y.XmlElement).insert(1, [outsideContainer]);
    const anchor = Y.createRelativePositionFromTypeIndex(first, 4),
      end = Y.createRelativePositionFromTypeIndex(last, 7);
    const updates: Uint8Array[] = [];
    document.on("update", (update) => updates.push(update));
    expect(normalizeYCodeBlocks(document)).toBe(true);
    expect(code.get(0)).toBe(first);
    expect(code.get(2)).toBe(last);
    expect(Y.createAbsolutePositionFromRelativePosition(anchor, document)).toMatchObject({ type: first, index: 4 });
    expect(Y.createAbsolutePositionFromRelativePosition(end, document)).toMatchObject({ type: last, index: 7 });
    expect(first.toDelta()).toEqual([
      { insert: "  😀first", attributes: { "comment--0123abcd": annotation, "comment--legacy_thread": annotation } },
    ]);
    expect(last.toDelta()).toEqual([{ insert: "\tsecond\n" }]);
    expect(outsideText.toDelta()).toEqual([{ insert: "Styled outside code", attributes: { bold: {} } }]);
    const normalized = yXmlFragmentToProsemirrorJSON(document.getXmlFragment("document-store"));
    validateDocumentTree(normalized);
    expect(normalized.content![0]!.content![0]!.content![0]!.content!.map((node) => node.text).join("")).toBe(
      "  😀first\n\tsecond\n",
    );
    expect(updates).toHaveLength(1);
    expect(normalizeYCodeBlocks(document)).toBe(false);
    expect(updates).toHaveLength(1);
    document.destroy();
  });

  it("preflights all code before repair so unknown atoms cannot cause a partial rewrite", () => {
    const { document, code } = legacyDocument([{ type: "text", text: "known", marks: [{ type: "bold" }] }]);
    const other = new Y.XmlElement("codeBlock"),
      unknown = new Y.XmlElement("footnoteReference");
    other.insert(0, [unknown]);
    (document.getXmlFragment("document-store").get(0) as Y.XmlElement).insert(0, [other]);
    const before = Y.encodeStateAsUpdate(document);
    expect(() => normalizeYCodeBlocks(document)).toThrow(/unsupported/);
    expect(Y.encodeStateAsUpdate(document)).toEqual(before);
    expect((code.get(0) as Y.XmlText).toDelta()[0]!.attributes).toEqual({ bold: {} });
    document.destroy();
  });
});
