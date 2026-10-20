import "server-only";
import type { CampusItem, Decision, DemoState, Draft, Profile } from "../types";
import { freshDemo } from "../seeds";
import { catalogIdentity } from "../backend-contract";
import { decodeSearchResults } from "../recommendations";
import { databasePrefix, transaction, type Query } from "./database";
const P = () => databasePrefix();
const campus = () => process.env.SNOWFLAKE_CAMPUS || "UMD";
const numberId = (value: unknown) => {
  const text=String(value);
  if(!/^[1-9]\d*$/.test(text))throw new Error("Invalid stored ID.");
  return text;
};
// Guest users are never deleted (reset keeps the row), so a resolved ID stays valid for this server's lifetime.
const userCache=(globalThis as typeof globalThis & { terplinkUserIds?: Map<string,string> }).terplinkUserIds ||= new Map<string,string>();
export async function ensureUser(q:Query, guestKey:string) {
  const cached=userCache.get(guestKey);
  if(cached)return cached;
  await q(`INSERT INTO ${P()}.USERS (APP_USER_KEY,NAME,USERNAME) SELECT ?,'New student',? WHERE NOT EXISTS (SELECT 1 FROM ${P()}.USER_IDENTITIES WHERE APP_USER_KEY=?)`,[guestKey,guestKey,guestKey]);
  const rows=await q(`SELECT USER_ID FROM ${P()}.USER_IDENTITIES WHERE APP_USER_KEY=?`,[guestKey]);
  if(rows.length!==1)throw new Error("Guest identity is ambiguous.");
  const userId=numberId(rows[0].USER_ID);
  const defaults=freshDemo().profile;
  // Profile initialization is idempotent; an existing profile is never overwritten.
  await q(`MERGE INTO ${P()}.PROFILES t USING (SELECT ? AS U) s ON t.USER_ID=s.U WHEN NOT MATCHED THEN INSERT (USER_ID,NAME,MAJOR,BIO,AVAILABILITY) VALUES(s.U,?,?,?,?)`,[userId,defaults.name,defaults.major,defaults.bio,defaults.availability]);
  userCache.set(guestKey,userId);
  return userId;
}
async function profileId(q:Query,userId:string) {
  const rows=await q(`SELECT PROFILE_ID FROM ${P()}.PROFILES WHERE USER_ID=?`,[userId]);
  if(rows.length!==1)throw new Error("Profile is ambiguous.");
  return numberId(rows[0].PROFILE_ID);
}
export async function readProfile(q:Query,userId:string):Promise<Profile> {
  const rows=await q(`SELECT * FROM ${P()}.PROFILES WHERE USER_ID=?`,[userId]);
  if(rows.length!==1)throw new Error("Profile not available.");
  const row=rows[0];
  const tags=await q(`SELECT DISTINCT t.TAG_NAME FROM ${P()}.PROFILE_TAGS pt JOIN ${P()}.TAGS t ON t.TAG_ID=pt.TAG_ID WHERE pt.PROFILE_ID=? ORDER BY t.TAG_NAME`,[numberId(row.PROFILE_ID)]);
  return {name:String(row.NAME || "New student"),major:String(row.MAJOR || ""),bio:String(row.BIO || ""),availability:String(row.AVAILABILITY || ""),interests:tags.map(r=>String(r.TAG_NAME))};
}
async function writeTags(q:Query, relation:"PROFILE_TAGS"|"EVENT_TAGS"|"GROUP_TAGS", key:"PROFILE_ID"|"EVENT_ID"|"GROUP_ID", id:string, values:string[]) {
  await q(`DELETE FROM ${P()}.${relation} WHERE ${key}=?`,[id]);
  if(!values.length)return;
  const encoded=JSON.stringify(values);
  await q(`MERGE INTO ${P()}.TAGS t USING (SELECT DISTINCT VALUE::VARCHAR AS NAME FROM TABLE(FLATTEN(INPUT=>PARSE_JSON(?)))) s ON t.TAG_NAME=s.NAME WHEN NOT MATCHED THEN INSERT(TAG_NAME) VALUES(s.NAME)`,[encoded]);
  await q(`INSERT INTO ${P()}.${relation} (${key},TAG_ID) SELECT ?, MIN(t.TAG_ID) FROM ${P()}.TAGS t JOIN TABLE(FLATTEN(INPUT=>PARSE_JSON(?))) f ON t.TAG_NAME=f.VALUE::VARCHAR GROUP BY t.TAG_NAME`,[id,encoded]);
}
async function applyProfile(q:Query,userId:string,profile:Profile) {
  const id=await profileId(q,userId);
  await q(`UPDATE ${P()}.PROFILES SET NAME=?,MAJOR=?,BIO=?,AVAILABILITY=? WHERE USER_ID=?`,[profile.name,profile.major,profile.bio,profile.availability,userId]);
  await writeTags(q,"PROFILE_TAGS","PROFILE_ID",id,profile.interests);
  return profile;
}
export async function saveProfile(q:Query,userId:string,profile:Profile) {
  return transaction(q,()=>applyProfile(q,userId,profile));
}
const catalogSelect=()=>`SELECT ITEM_ID, ITEM_TYPE, TITLE, DESCRIPTION, TAGS, CAMPUS, IS_ACTIVE, LOCATION, MEETING_DETAILS, IS_DEMO, TO_CHAR(STARTS_AT,'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS STARTS_AT, TO_CHAR(CREATED_AT,'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS CREATED_AT FROM ${P()}.DISCOVERY_CATALOG`;
export async function readState(q:Query,userId:string):Promise<DemoState> {
  const profile=await readProfile(q,userId);
  const history=await q(`SELECT ITEM_ID,ACTION FROM ${P()}.SWIPES WHERE USER_ID=?`,[userId]);
  const rows=await q(`${catalogSelect()} WHERE CAMPUS=? AND ((IS_ACTIVE=1 AND COALESCE(IS_DEMO,FALSE)=FALSE) OR ITEM_ID IN (SELECT ITEM_ID FROM ${P()}.SWIPES WHERE USER_ID=?)) ORDER BY CASE WHEN ITEM_TYPE='event' AND STARTS_AT>=CURRENT_TIMESTAMP() THEN 0 WHEN ITEM_TYPE='group' THEN 1 ELSE 2 END, STARTS_AT ASC NULLS LAST, CREATED_AT DESC NULLS LAST, ITEM_ID LIMIT 5000`,[campus(),userId]);
  const items=decodeSearchResults({results:rows},{query:"",kind:"all",excludedIds:[]},campus(),new Date(),true);
  const decisions:Record<string,Decision>={};
  for(const row of history)if(row.ACTION==="interested"||row.ACTION==="pass")decisions[`snowflake:${row.ITEM_ID}`]=row.ACTION;
  return {version:1,profile,items,decisions};
}
export async function saveDecision(q:Query,userId:string,id:string,action:Decision) {
  const item=catalogIdentity(id);
  const rawId=`${item.kind}:${item.numericId}`;
  // One round trip: the catalog check is the MERGE source, so an unknown card changes nothing.
  const rows=await q(`MERGE INTO ${P()}.SWIPES t USING (SELECT ? AS U,ITEM_ID AS I,? AS A FROM ${P()}.DISCOVERY_CATALOG WHERE ITEM_ID=? AND CAMPUS=?) s ON t.USER_ID=s.U AND t.ITEM_ID=s.I WHEN MATCHED THEN UPDATE SET ACTION=s.A,SWIPED_AT=CURRENT_TIMESTAMP() WHEN NOT MATCHED THEN INSERT(USER_ID,ITEM_ID,ACTION) VALUES(s.U,s.I,s.A)`,[userId,action,rawId,campus()]);
  const changed=Object.values(rows[0] || {}).reduce<number>((sum,value)=>sum+Number(value || 0),0);
  if(changed!==1)throw new Error("Card not found.");
}
/** Undo a swipe (the Discover "go back" button). Deleting a missing row is a no-op. */
export async function clearDecision(q:Query,userId:string,id:string) {
  const item=catalogIdentity(id);
  await q(`DELETE FROM ${P()}.SWIPES WHERE USER_ID=? AND ITEM_ID=?`,[userId,`${item.kind}:${item.numericId}`]);
}
export async function publishItem(q:Query,userId:string,draft:Draft,key:string):Promise<CampusItem> {
  return transaction(q,async()=> {
    const event=draft.kind==="event", table=event?"EVENTS":"GROUPS", idColumn=event?"EVENT_ID":"GROUP_ID";
    if(event)await q(`MERGE INTO ${P()}.EVENTS t USING (SELECT ? AS K) s ON t.APP_ITEM_KEY=s.K WHEN NOT MATCHED THEN INSERT(APP_ITEM_KEY,EVENT_TITLE,EVENT_DESCRIPTION,LOCATION,STARTS_AT,CAMPUS,IS_ACTIVE,IS_DEMO,CREATED_AT,CREATED_BY_USER_ID) VALUES(s.K,?,?,?,CONVERT_TIMEZONE('America/New_York','UTC',TO_TIMESTAMP_NTZ(?))::TIMESTAMP_TZ,?,1,FALSE,CURRENT_TIMESTAMP(),?)`,[key,draft.title,draft.description,draft.location,`${draft.date} ${draft.time}:00`,campus(),userId]);
    else await q(`MERGE INTO ${P()}.GROUPS t USING (SELECT ? AS K) s ON t.APP_ITEM_KEY=s.K WHEN NOT MATCHED THEN INSERT(APP_ITEM_KEY,GROUP_NAME,GROUP_DESCRIPTION,LOCATION,MEETING_DETAILS,CAMPUS,IS_ACTIVE,IS_DEMO,CREATED_AT,CREATED_BY_USER_ID) VALUES(s.K,?,?,?,?,?,1,FALSE,CURRENT_TIMESTAMP(),?)`,[key,draft.title,draft.description,draft.location,draft.meetingDetails,campus(),userId]);
    const rows=await q(`SELECT ${idColumn} AS ID FROM ${P()}.${table} WHERE APP_ITEM_KEY=? AND CREATED_BY_USER_ID=?`,[key,userId]);
    if(rows.length!==1)throw new Error("Publish could not be verified.");
    const id=numberId(rows[0].ID);
    await writeTags(q,event?"EVENT_TAGS":"GROUP_TAGS",idColumn,id,draft.tags);
    const cards=await q(`${catalogSelect()} WHERE ITEM_ID=?`,[`${draft.kind}:${id}`]);
    const result=decodeSearchResults({results:cards},{query:"",kind:"all",excludedIds:[]},campus(),new Date());
    if(result.length!==1)throw new Error("Published card is unreadable.");
    return result[0];
  });
}
export async function resetUser(q:Query,userId:string) {
  await transaction(q,async()=> {
    await applyProfile(q,userId,freshDemo().profile);
    await q(`DELETE FROM ${P()}.SWIPES WHERE USER_ID=?`,[userId]);
  });
  // Published cards belong to the shared catalog and are preserved by reset.
}
export async function recheckResults(q:Query, items:CampusItem[], userId:string):Promise<CampusItem[]> {
  if(!items.length)return [];
  const rawIds=items.map(item=> {const p=catalogIdentity(item.id);return `${p.kind}:${p.numericId}`;});
  const rows=await q(`${catalogSelect()} WHERE CAMPUS=? AND COALESCE(IS_DEMO,FALSE)=FALSE AND ITEM_ID IN (${rawIds.map(()=>"?").join(",")}) AND ITEM_ID NOT IN (SELECT ITEM_ID FROM ${P()}.SWIPES WHERE USER_ID=?)`,[campus(),...rawIds,userId]);
  const current=new Map(decodeSearchResults({results:rows},{query:"",kind:"all",excludedIds:[]},campus(),new Date()).map(item=>[item.id,item]));
  return items.map(item=>current.get(item.id)).filter((item):item is CampusItem=>Boolean(item));
}
