import maplibreSource from 'maplibre-gl/dist/maplibre-gl.mjs?raw';
import workerSource from 'maplibre-gl/dist/maplibre-gl-worker.mjs?raw';
import maplibreCss from 'maplibre-gl/dist/maplibre-gl.css?raw';

import { HTML_RENDER_MIN_HEIGHT } from '@/components/chat/message/parts/htmlRender';

import { BASEMAP_SCHEME } from '../basemapClient';
import { asClassicScript } from './classicScript';

/**
 * What a page in the chat that draws a map gets before its own scripts: MapLibre as the global `maplibregl`, from the
 * app's own copy, so a map draws offline; `geocode.vector` and `geocode.raster`, which read data through the chat
 * (pageMaps.ts), and `geocode.basemap`, the app's basemap read the same way; and a line at the top of the page that shows what went wrong, titled in the interface's language
 * (self.geocodeKitText, set before the kit by pageMaps.ts). Loaded only for such a page, as it weighs what MapLibre
 * does. The agent reads how to use them in packages/web/server/geocode/map-pages.js; change both together.
 */

// As a string in a script: `</` could close the script it stands in.
const inScript = (text: string) => JSON.stringify(text).replaceAll('</', '<\\/');

const BRIDGE = `(function(){
var T=self.geocodeKitText,told=new Set(),lines=[],bar=null,title,detail,open=false,own=new WeakSet(),used=false;
["pointerdown","keydown","wheel"].forEach(function(type){window.addEventListener(type,function(){used=true;},{capture:true,once:true});});
// An error while the page is still coming up, before the user works in it, leaves the line alone on the page, filling
// the frame's least height: a page that failed to come up is mostly an empty box. Later, the line is added above it.
var hiding=document.createElement("style");hiding.textContent="body[data-geocode-failed]>:not([data-geocode-error]){display:none!important}"
+"body[data-geocode-failed]>[data-geocode-error]{box-sizing:border-box;min-height:${HTML_RENDER_MIN_HEIGHT}px;margin:0!important;align-items:center!important}";document.head.appendChild(hiding);
function show(){if(!bar){bar=document.createElement("div");bar.setAttribute("role","alert");bar.setAttribute("data-geocode-error","");
if(!used)document.body.setAttribute("data-geocode-failed","");
bar.style.cssText="display:flex;gap:6px;align-items:baseline;margin:0 0 8px;padding:3px 8px;border-radius:var(--radius,6px);background:color-mix(in srgb,var(--destructive) 10%,transparent);font-size:0.8125em;line-height:1.5;cursor:pointer";
title=document.createElement("span");title.style.cssText="flex:none;color:var(--destructive);font-weight:500";
detail=document.createElement("span");detail.style.cssText="flex:1;min-width:0;color:var(--muted-foreground);user-select:text";
bar.append(title,detail);bar.addEventListener("click",function(){if(String(getSelection()))return;open=!open;show();});
document.body.insertBefore(bar,document.body.firstChild);}
title.textContent="\\u26a0 "+T[lines[0].kind]+(lines.length>1?" ("+lines.length+")":"");
detail.textContent=lines.map(function(l){return l.text;}).join(open?"\\n":" \\u00b7 ");
detail.style.whiteSpace=open?"pre-wrap":"nowrap";detail.style.overflow=open?"visible":"hidden";detail.style.textOverflow=open?"clip":"ellipsis";detail.style.overflowWrap="anywhere";}
function report(kind,text){text=String(text).slice(0,500);if(told.has(text)||told.size>=8)return;told.add(text);lines.push({kind:kind,text:text});
if(document.body)show();else document.addEventListener("DOMContentLoaded",show);}
window.addEventListener("error",function(e){report("script",e.message);});
window.addEventListener("unhandledrejection",function(e){var r=e.reason;if(!own.has(r))report("script",r&&r.message||r);});
var Base=self.maplibregl.Map;
// Whatever the page asks: the credit of the basemap, written small in the corner as the preview's is, rather than
// MapLibre's own folded behind a button; nothing else the page draws has one, so a map without the basemap shows none.
// Never zoomed by the wheel, so scrolling the chat over a map scrolls the chat; dragging, which takes a deliberate
// press, still moves it.
// And a handler for "load" added once the map has loaded runs then, rather than never: a page that awaits its data
// before adding one would otherwise draw none, the basemap loading first.
var loaded=new WeakSet();
function later(map,handler){var timer=setTimeout(function(){handler.call(map,{type:"load",target:map});});return {unsubscribe:function(){clearTimeout(timer);}};}
self.maplibregl.Map=class Map extends Base{constructor(options){super(Object.assign({},options,{attributionControl:{compact:false},scrollZoom:false}));
var map=this;super.once("load",function(){loaded.add(map);});
this.on("error",function(e){report("map",e&&e.error&&e.error.message||"error");});}
on(type,a,b){return type==="load"&&loaded.has(this)&&typeof a==="function"&&b===undefined?later(this,a):super.on(type,a,b);}
once(type,a,b){if(type!=="load"||!loaded.has(this))return super.once(type,a,b);
if(a===undefined)return Promise.resolve({type:"load",target:this});if(typeof a!=="function"||b!==undefined)return super.once(type,a,b);later(this,a);return this;}};
Object.freeze(self.maplibregl);
var worker=URL.createObjectURL(new Blob([${inScript(workerSource)}],{type:"text/javascript"}));
self.maplibregl.setWorkerUrl(worker);
// Borders and padding within the widths a page sets, as most pages are written for: a map 100% wide with a border
// would otherwise overflow the frame. Before the page's own styles, which win over it.
var style=document.createElement("style");style.textContent="*,*::before,*::after{box-sizing:border-box}"+${inScript(maplibreCss)}+".maplibregl-ctrl.maplibregl-ctrl-attrib{background:transparent;padding:0 4px;font-size:9px;line-height:14px;color:var(--muted-foreground)}";document.head.appendChild(style);
var asked=new Map(),next=1;
// A failed read is shown even where the page catches it.
function fail(w,error){own.add(error);report("data",error.message+(typeof w.path==="string"?" ("+w.path.split(/[\\\\/]/).pop()+")":""));w.reject(error);}
window.addEventListener("message",function(event){var d=event.data,w;if(event.source!==parent||!d||d.type!=="geocode/result")return;w=asked.get(d.id);if(!w)return;asked.delete(d.id);
if(d.error)return fail(w,new Error(d.error));try{w.resolve(w.read(d));}catch(x){fail(w,x);}});
function ask(type,path,options,extra,problem,read){return new Promise(function(resolve,reject){var w={path:path,resolve:resolve,reject:reject,read:read},id;
if(typeof path!=="string")problem="path must be a string";else if(options.layer!==undefined&&typeof options.layer!=="string")problem="layer must be a layer's name";
// A page opened outside GeoCode, as one saved with the download button, has no chat to read through.
else if(parent===self)problem="the data can be read only in GeoCode";
if(problem)return fail(w,new Error(problem));id=next++;asked.set(id,w);
parent.postMessage(Object.assign({type:type,id:id,path:path,layer:options.layer},extra),"*");});}
// The basemap's tiles and icons, which its style names by this scheme, read through the chat as the data is.
self.maplibregl.addProtocol("${BASEMAP_SCHEME}",function(params){return new Promise(function(resolve,reject){var id=next++;
asked.set(id,{resolve:resolve,reject:reject,read:function(d){return {data:params.type==="json"?JSON.parse(new TextDecoder().decode(d.bytes)):d.bytes};}});
parent.postMessage({type:"geocode/basemap-resource",id:id,url:params.url},"*");});});
self.geocode=Object.freeze({
// The style of the basemap the settings choose, in the interface's theme and language; an empty one when they choose none.
basemap:function(){return new Promise(function(resolve,reject){var w={resolve:resolve,reject:reject,read:function(d){return d.style||{version:8,sources:{},layers:[]};}},id;
if(parent===self)return fail(w,new Error("the basemap can be read only in GeoCode"));id=next++;asked.set(id,w);parent.postMessage({type:"geocode/basemap",id:id},"*");});},
vector:function(path,options){options=options||{};var fields=options.fields===undefined?[]:options.fields;
return ask("geocode/vector",path,options,{fields:fields},!Array.isArray(fields)||fields.some(function(f){return typeof f!=="string";})?"fields must be an array of field names":"",
function(d){return JSON.parse(new TextDecoder().decode(d.bytes));});},
// As geotiff.js's readRasters gives a raster: a typed array a band, with width and height on the array.
raster:function(path,options){options=options||{};var bands=options.bands===undefined?[1]:options.bands;
return ask("geocode/raster",path,options,{bands:bands},!Array.isArray(bands)||!bands.length||bands.some(function(b){return !Number.isInteger(b)||b<1;})?"bands must be an array of band numbers, from 1":"",
function(d){var g=d.grid,size=g.width*g.height,out=[],i;for(i=0;i<g.bands;i++)out.push(new Float32Array(d.bytes,i*size*4,size));
out.width=g.width;out.height=g.height;out.coordinates=g.coordinates;if(g.palette)out.palette=g.palette;return out;});}});
})();`;

let kit: string | undefined;

/** The script a map page gets, made once. */
export const pageMapKit = (): string => {
  kit ??= `<script>${asClassicScript(maplibreSource)}</script><script>${BRIDGE}</script>`;
  return kit;
};
