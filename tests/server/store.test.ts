import { test } from "node:test";
import assert from "node:assert/strict";
import { transaction,type Query,type Rows } from "../../lib/server/database";
import { publishItem,saveDecision,saveProfile,recheckResults } from "../../lib/server/store";
import { sameOrigin,readJson } from "../../lib/server/http";

test("database transaction rolls back a failed write",async()=> {
 const calls:string[]=[];const q:Query=async sql=>{calls.push(sql);return [];};
 await assert.rejects(transaction(q,async()=>{throw new Error("broken");}));
 assert.deepEqual(calls,["BEGIN TRANSACTION","ROLLBACK"]);
});
test("profile changes and tag relationships commit together and bind user text",async()=> {
 const calls:{sql:string;binds:unknown}[]=[];
 const q:Query=async(sql,binds)=>{calls.push({sql,binds});return sql.startsWith("SELECT PROFILE_ID")?[{PROFILE_ID:9}]:[];};
 const profile={name:"x';DELETE",major:"CS",bio:"",availability:"",interests:["AI"]};
 await saveProfile(q,"3",profile);
 assert.equal(calls[0].sql,"BEGIN TRANSACTION");assert.equal(calls.at(-1)?.sql,"COMMIT");
 const update=calls.find(c=>c.sql.startsWith("UPDATE"))!;
 assert.ok(!update.sql.includes(profile.name));assert.ok((update.binds as string[]).includes(profile.name));
 assert.ok(calls.some(c=>c.sql.includes("PROFILE_TAGS")&&c.sql.startsWith("INSERT")));
});
test("swipe ownership comes from the session user and only catalog IDs are accepted",async()=> {
 const calls:{sql:string;binds:unknown}[]=[];
 const q:Query=async(sql,binds)=>{calls.push({sql,binds});return [{"number of rows inserted":(binds as string[])[2]==="group:1"?1:0,"number of rows updated":0}];};
 await saveDecision(q,"27","snowflake:group:1","interested");
 assert.equal(calls.length,1);
 assert.ok(calls[0].sql.includes("DISCOVERY_CATALOG"));
 assert.deepEqual(calls[0].binds,["27","interested","group:1","UMD"]);
 await assert.rejects(saveDecision(q,"27","snowflake:group:2","pass"));
 await assert.rejects(saveDecision(q,"27","demo-1","pass"));
});
const row={ITEM_ID:"group:9",ITEM_TYPE:"group",TITLE:"My Club",DESCRIPTION:"Coding",TAGS:"AI",CAMPUS:"UMD",STARTS_AT:null,IS_ACTIVE:1,IS_DEMO:false,LOCATION:"Iribe",MEETING_DETAILS:"Fridays",CREATED_AT:"2026-10-04T12:00:00Z"};
test("publishing uses a retry key and transaction and returns the persisted card",async()=> {
 const calls:{sql:string;binds:unknown}[]=[];
 const q:Query=async(sql,binds)=>{calls.push({sql,binds});if(sql.startsWith("SELECT GROUP_ID"))return [{ID:9}];if(sql.includes("DISCOVERY_CATALOG")&&sql.startsWith("SELECT"))return [row];return [];};
 const item=await publishItem(q,"27",{kind:"group",title:"My Club",description:"Coding",tags:["AI"],location:"Iribe",meetingDetails:"Fridays",date:"",time:""},"request-key");
 assert.equal(item.id,"snowflake:group:9");assert.equal(item.demo,false);
 const merge=calls.find(c=>c.sql.startsWith("MERGE INTO")&&c.sql.includes("GROUPS"))!;
 assert.ok(merge.sql.includes("APP_ITEM_KEY"));assert.equal((merge.binds as string[])[0],"request-key");
 assert.equal(calls.at(-1)?.sql,"COMMIT");
});
test("search recheck removes cancelled cards and preserves the search order",async()=> {
 const q:Query=async()=>[row,{...row,ITEM_ID:"group:10",IS_ACTIVE:0}];
 const base={id:"snowflake:group:9",kind:"group" as const,title:"My Club",description:"Coding",tags:[],location:"",date:"",time:"",meetingDetails:"",demo:false,color:0,createdAt:""};
 const result=await recheckResults(q,[{...base,id:"snowflake:group:10"},base],"27");
 assert.deepEqual(result.map(i=>i.id),[base.id]);
});
test("mutations reject cross-origin requests and bound JSON bodies",async()=> {
 assert.throws(()=>sameOrigin(new Request("https://app.test/api/items",{headers:{origin:"https://evil.test"}})));
 sameOrigin(new Request("https://app.test/api/items",{headers:{origin:"https://app.test"}}));
 await assert.rejects(readJson(new Request("https://app.test/api/items",{method:"POST",headers:{"Content-Type":"application/json"},body:"x".repeat(33000)})));
});
