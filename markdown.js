function f(){let e=globalThis.MGCanvasRuntime;if(!e)throw new Error("[plugin-sdk] MGCanvas \u8FD0\u884C\u65F6\u672A\u5C31\u7EEA:\u8BF7\u5728\u753B\u5E03\u5BBF\u4E3B\u4E2D\u52A0\u8F7D\u672C\u63D2\u4EF6");return e}function r(){return f().React}var p=((...e)=>r().useState(...e)),c=((...e)=>r().useEffect(...e));var d=((...e)=>r().useRef(...e));var g=`.cnv-md {
    height: 100%;
    width: 100%;
    overflow: auto;
    padding: 16px;
    font-size: 14px;
    line-height: 1.6;
}
.cnv-md h1,
.cnv-md h2,
.cnv-md h3 {
    margin: 0.6em 0 0.3em;
    font-weight: 600;
    line-height: 1.3;
}
.cnv-md h1 {
    font-size: 1.5em;
}
.cnv-md h2 {
    font-size: 1.3em;
}
.cnv-md p {
    margin: 0.5em 0;
}
.cnv-md a {
    color: #6366f1;
    text-decoration: underline;
}
.cnv-md code {
    padding: 0.1em 0.35em;
    border-radius: 4px;
    background: rgba(120, 120, 120, 0.16);
    font-family: monospace;
    font-size: 0.9em;
}
.cnv-md pre {
    padding: 12px;
    border-radius: 8px;
    background: rgba(120, 120, 120, 0.14);
    overflow: auto;
}
.cnv-md pre code {
    padding: 0;
    background: transparent;
}
.cnv-md ul,
.cnv-md ol {
    padding-left: 1.4em;
    margin: 0.5em 0;
}
.cnv-md blockquote {
    margin: 0.5em 0;
    padding-left: 0.8em;
    border-left: 3px solid rgba(120, 120, 120, 0.4);
    opacity: 0.85;
}
.cnv-md img {
    max-width: 100%;
}
`;var v=Symbol.for("mgcanvas.jsx.fragment");function x(e,n,t){let u=r(),l=e===v?u.Fragment:e,a=t===void 0?n:{...n??{},key:t};return u.createElement(l,a)}function i(e,n,t){return x(e,n,t)}var s,m;function C(){return s?Promise.resolve(s):(m||(m=import("https://esm.sh/marked@14").then(e=>s=e.marked)),m)}var h="*\u9009\u4E2D\u8282\u70B9,\u70B9\u4E0A\u65B9\u5DE5\u5177\u6761\u7684 \u270E \u7F16\u8F91 Markdown*",k=new Map;function P(e){if(!s)return"";let n=e||h,t=k.get(n);return t===void 0&&(t=s.parse(n),k.set(n,t)),t}function b({ctx:e}){let[,n]=p(0),t=d(null),u=d(null);c(()=>{if(s)return;let o=!0;return C().then(()=>o&&n(R=>R+1)),()=>{o=!1}},[]);let l=e.node.metadata?.content||"",a=P(l);return c(()=>{let o=t.current;!o||u.current===a||(o.innerHTML=a,u.current=a)},[a]),i("div",{ref:t,className:"cnv-md","data-canvas-no-zoom":!0,onWheel:o=>o.stopPropagation(),style:{height:"100%",width:"100%",color:e.theme.node.text}})}function M({ctx:e}){let n=e.node.metadata?.content||"";return i("textarea",{autoFocus:!0,value:n,placeholder:"# \u8F93\u5165 Markdown",onChange:t=>e.updateMetadata({content:t.target.value}),onMouseDown:t=>t.stopPropagation(),onPointerDown:t=>t.stopPropagation(),onWheel:t=>t.stopPropagation(),style:{height:"100%",width:"100%",resize:"none",background:e.theme.node.fill,borderRadius:16,boxSizing:"border-box",padding:16,fontFamily:"monospace",fontSize:14,outline:"none",border:"none",color:e.theme.node.text}})}function E({ctx:e}){return e.node.metadata?.editing?i(M,{ctx:e}):i(b,{ctx:e})}var O={id:"markdown",name:"Markdown \u8282\u70B9",version:"1.1.0",description:"\u5728\u753B\u5E03\u4E2D\u7F16\u8F91\u4E0E\u6E32\u67D3 Markdown",css:g,nodes:[{type:"markdown:doc",title:"Markdown",icon:"\u{1F4DD}",description:"\u7F16\u8F91\u4E0E\u6E32\u67D3 Markdown",defaultSize:{width:360,height:300},defaultMetadata:{content:""},minimapColor:"#6366f1",hidePanel:!0,interactionToggle:!0,forceInteractive:e=>!!e.metadata?.editing,resource:e=>({kind:"text",text:e.metadata?.content}),Content:E,toolbar:e=>{let n=!!e.node.metadata?.editing;return[{id:"md-toggle-edit",title:n?"\u9884\u89C8\u6E32\u67D3\u7ED3\u679C":"\u7F16\u8F91 Markdown \u6E90\u7801",label:n?"\u9884\u89C8":"\u7F16\u8F91",icon:n?"\u{1F441}":"\u270E",active:n,onClick:()=>e.updateMetadata({editing:!n})}]}}]};export{O as default};
