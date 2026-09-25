require("dotenv").config();
const express=require("express");
const path=require("path");
const fs=require("fs");
const crypto=require("crypto");
const TelegramBot=require("node-telegram-bot-api");

const app=express();
const PORT=Number(process.env.PORT||10000);
const ADMIN_ID=process.env.ADMIN_ID||"TANVIR";
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"CHANGE_THIS";
const AUTO_START=String(process.env.AUTO_START_BOTS||"false").toLowerCase()==="true";

app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname,"public")));

const dir=path.join(__dirname,"data");
const file=path.join(dir,"data.json");
if(!fs.existsSync(dir))fs.mkdirSync(dir,{recursive:true});
if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify({bots:[],pages:[],users:{}},null,2));

function load(){try{return JSON.parse(fs.readFileSync(file,"utf8"))}catch(e){console.error("DATA_READ",e);return{bots:[],pages:[],users:{}}}}
let db=load();
function save(){try{fs.writeFileSync(file,JSON.stringify(db,null,2))}catch(e){console.error("DATA_WRITE",e)}}

const running=new Map(),adminSessions=new Map();

async function tg(token,method,body={}){
  const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)
  });
  const d=await r.json();
  if(!d.ok)throw new Error(d.description||"Telegram API error");
  return d.result;
}

function pub(b){return{id:b.id,name:b.name,username:b.username||"",running:running.has(b.id),created:b.created}}
function page(id){return db.pages.find(x=>x.id===Number(id))}
function keyboard(p){
  const rows={};
  for(const b of (p?.buttons||[])){
    const r=Math.max(1,Math.min(8,Number(b.row)||1));
    (rows[r]??=[]).push(b.action==="url"?{text:b.name,url:b.value}:{text:b.name,callback_data:"btn:"+b.id});
  }
  return Object.keys(rows).sort((a,b)=>a-b).map(k=>rows[k]);
}

function startBot(id){
  if(running.has(id))return;
  const rec=db.bots.find(x=>x.id===id);
  if(!rec)throw new Error("Bot not found");
  const bot=new TelegramBot(rec.token,{polling:true});
  running.set(id,bot);
  console.log("BOT_STARTED",rec.username);

  bot.on("polling_error",e=>console.error("POLLING_ERROR",e.message));

  bot.on("message",async m=>{
    try{
      const uid=String(m.from?.id||"");
      if(uid){db.users[uid]={id:uid,username:m.from.username||"",name:m.from.first_name||"",lastSeen:Date.now()};save()}
      if(m.text!=="/start")return;
      const p=db.pages[0];
      await bot.sendMessage(m.chat.id,p?.text||"Welcome!",{reply_markup:{inline_keyboard:keyboard(p)}});
    }catch(e){console.error("MESSAGE_ERROR",e.message)}
  });

  bot.on("callback_query",async q=>{
    try{
      await bot.answerCallbackQuery(q.id);
      if(!String(q.data||"").startsWith("btn:"))return;
      const id=Number(q.data.slice(4));
      let b=null;
      for(const p of db.pages){b=(p.buttons||[]).find(x=>x.id===id);if(b)break}
      if(!b)return;
      const chat=q.message.chat.id;
      if(b.action==="page"){
        const p=page(b.value);if(!p)return;
        await bot.editMessageText(p.text||p.name,{chat_id:chat,message_id:q.message.message_id,reply_markup:{inline_keyboard:keyboard(p)}});
      }else if(b.action==="text"){
        await bot.sendMessage(chat,b.value||b.name);
      }else{
        const v=b.value||b.name;
        if(v==="Profile")await bot.sendMessage(chat,`Name: ${q.from.first_name||""}\nUsername: ${q.from.username?"@"+q.from.username:"Not set"}\nID: ${q.from.id}`);
        else if(v==="My Balance")await bot.sendMessage(chat,"Balance: 0 BDT");
        else if(v==="Transaction History")await bot.sendMessage(chat,"No transactions yet.");
        else await bot.sendMessage(chat,String(v));
      }
    }catch(e){console.error("BUTTON_ERROR",e.message)}
  });
}

function stopBot(id){
  const b=running.get(id);
  if(b){try{b.stopPolling()}catch(e){}}
  running.delete(id);
}

app.get("/api/health",(req,res)=>res.json({ok:true,node:process.version,running:running.size,bots:db.bots.length,time:new Date().toISOString()}));

app.get("/api/bots",(req,res)=>res.json({bots:db.bots.map(pub)}));

app.post("/api/bots",async(req,res)=>{
  try{
    const name=String(req.body.name||"").trim(),token=String(req.body.token||"").trim();
    if(!name||!token)return res.status(400).json({error:"Name and token are required"});
    const me=await tg(token,"getMe");
    if(db.bots.some(x=>x.token===token))return res.status(409).json({error:"Bot already connected"});
    const b={id:Date.now(),name,token,username:me.username||"",created:Date.now()};
    db.bots.push(b);save();res.json({bot:pub(b)});
  }catch(e){console.error("ADD_BOT",e);res.status(400).json({error:e.message})}
});

app.post("/api/bots/:id/start",(req,res)=>{try{startBot(Number(req.params.id));res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.post("/api/bots/:id/stop",(req,res)=>{stopBot(Number(req.params.id));res.json({ok:true})});
app.post("/api/bots/:id/restart",(req,res)=>{try{const id=Number(req.params.id);stopBot(id);startBot(id);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.delete("/api/bots/:id",(req,res)=>{const id=Number(req.params.id);stopBot(id);db.bots=db.bots.filter(x=>x.id!==id);save();res.json({ok:true})});

app.get("/api/pages",(req,res)=>res.json({pages:db.pages}));
app.post("/api/pages",(req,res)=>{
  const name=String(req.body.name||"").trim();
  if(!name)return res.status(400).json({error:"Page name required"});
  const p={id:Date.now(),name,text:"Welcome to "+name+".",buttons:[]};
  db.pages.push(p);save();res.json({page:p});
});
app.delete("/api/pages/:id",(req,res)=>{db.pages=db.pages.filter(x=>x.id!==Number(req.params.id));save();res.json({ok:true})});
app.post("/api/pages/:id/buttons",(req,res)=>{
  const p=page(req.params.id);if(!p)return res.status(404).json({error:"Page not found"});
  const name=String(req.body.name||"").trim(),action=String(req.body.action||"text"),value=String(req.body.value||"");
  if(!name)return res.status(400).json({error:"Button name required"});
  if(!["page","text","url","activity"].includes(action))return res.status(400).json({error:"Invalid action"});
  if(action==="url"&&!/^https?:\/\//i.test(value))return res.status(400).json({error:"URL must start with http:// or https://"});
  p.buttons.push({id:Date.now()+Math.floor(Math.random()*9999),name,action,value,row:Math.max(1,Math.min(8,Number(req.body.row)||1))});
  save();res.json({ok:true});
});
app.delete("/api/pages/:pid/buttons/:index",(req,res)=>{
  const p=page(req.params.pid),i=Number(req.params.index);
  if(!p||!p.buttons[i])return res.status(404).json({error:"Button not found"});
  p.buttons.splice(i,1);save();res.json({ok:true});
});

app.get("/api/preview",(req,res)=>res.json({bot:db.bots[0]?pub(db.bots[0]):null,page:db.pages[0]||null}));

app.post("/api/admin/login",(req,res)=>{
  if(String(req.body.id||"")!==ADMIN_ID||String(req.body.password||"")!==ADMIN_PASSWORD)return res.status(401).json({error:"Invalid credentials"});
  const t=crypto.randomBytes(32).toString("hex");adminSessions.set(t,Date.now()+86400000);res.json({token:t});
});
app.get("/api/admin/summary",(req,res)=>{
  const t=req.get("X-Admin-Token");
  if(!t||!adminSessions.has(t))return res.status(401).json({error:"Admin login required"});
  res.json({users:Object.keys(db.users).length,bots:db.bots.length,running:running.size});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT,"0.0.0.0",()=>{
  console.log("SERVER_STARTED",PORT,process.version);
  if(AUTO_START)for(const b of db.bots)try{startBot(b.id)}catch(e){console.error("AUTO_START",e.message)}
});
