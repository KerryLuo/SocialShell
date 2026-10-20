import "server-only";
import type { Connection, Pool, RowStatement } from "snowflake-sdk";
export type Rows = Record<string, unknown>[];
export type Query = (sql: string, binds?: (string | number | null)[]) => Promise<Rows>;
export const backendEnabled = () => process.env.SNOWFLAKE_BACKEND_ENABLED === "true";
export function databasePrefix() {
  const names = [process.env.SNOWFLAKE_DATABASE || "LIFEDATA", process.env.SNOWFLAKE_SCHEMA || "LIFEDATA"];
  if (!names.every(v => /^[a-z_][a-z0-9_]*$/i.test(v))) throw new Error("Invalid database configuration.");
  return names.map(v=>v.toUpperCase()).join(".");
}
// Opening a Snowflake session costs seconds; a warm pool makes each request just its queries.
const poolState = globalThis as typeof globalThis & { terplinkPool?: Promise<Pool<Connection>>; terplinkReadySessions?: WeakSet<Connection> };
const readySessions = poolState.terplinkReadySessions ||= new WeakSet();
function pool() {
  const e = process.env;
  if (!e.SNOWFLAKE_ACCOUNT || !e.SNOWFLAKE_USERNAME || !e.SNOWFLAKE_APP_TOKEN || !e.SNOWFLAKE_WAREHOUSE || !e.SNOWFLAKE_APP_ROLE || !e.SESSION_SECRET || e.SESSION_SECRET.length < 32) throw new Error("Database is not configured.");
  return poolState.terplinkPool ||= import("snowflake-sdk").then(({ default: sdk }) => {
    sdk.configure({ logLevel:"OFF" });
    return sdk.createPool({ account:e.SNOWFLAKE_ACCOUNT!, username:e.SNOWFLAKE_USERNAME!, password:e.SNOWFLAKE_APP_TOKEN!, authenticator:"SNOWFLAKE", warehouse:e.SNOWFLAKE_WAREHOUSE!, role:e.SNOWFLAKE_APP_ROLE!, timeout:15000, clientSessionKeepAlive:true }, { min:1, max:8, acquireTimeoutMillis:20000, testOnBorrow:true, evictionRunIntervalMillis:60000, idleTimeoutMillis:30*60000 });
  }).catch(error => { poolState.terplinkPool = undefined; throw error; });
}
export async function withDatabase<T>(work: (query: Query) => Promise<T>): Promise<T> {
  const connections = await pool();
  let connection: Connection;
  try { connection = await connections.acquire(); } catch { throw new Error("Database connection failed."); }
  let closed = false;
  let statement: RowStatement | undefined;
  const query: Query = (sqlText, binds=[]) => new Promise((resolve,reject)=> {
    if (closed) { reject(new Error("Connection closed.")); return; }
    try { statement = connection.execute({ sqlText, binds, complete(error,_stmt,rows) { if (error) reject(new Error("Database query failed.")); else resolve((rows || []) as Rows); } }); }
    catch { reject(new Error("Database query failed.")); }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve,reject)=> { timer=setTimeout(()=> { closed=true; statement?.cancel(()=>{}); reject(new Error("Database request timed out.")); },60000); });
  let healthy = false;
  try {
    const result = await Promise.race([deadline, (async()=> {
      if (!readySessions.has(connection)) { await query("ALTER SESSION SET TIMEZONE = 'UTC'"); readySessions.add(connection); }
      return work(query);
    })()]);
    healthy = true;
    return result;
  } finally {
    closed=true; clearTimeout(timer);
    // A failed or timed-out session may still hold an open transaction, so it is never reused.
    if (healthy) void connections.release(connection).catch(()=>{});
    else void connections.destroy(connection).catch(()=>{});
  }
}
export async function transaction<T>(q: Query, work: () => Promise<T>): Promise<T> {
  await q("BEGIN TRANSACTION");
  try { const result=await work(); await q("COMMIT"); return result; }
  catch(error) { await q("ROLLBACK").catch(()=>{}); throw error; }
}

// Serialize guest mutations in this one-server hackathon deployment.
// Standard Snowflake tables do not enforce UNIQUE constraints.
const lockState = globalThis as typeof globalThis & { terplinkGuestLocks?: Map<string,Promise<void>> };
const locks = lockState.terplinkGuestLocks ||= new Map();
export async function withGuestDatabase<T>(key:string, work:(q:Query)=>Promise<T>):Promise<T> {
  const previous=locks.get(key) || Promise.resolve();
  let release!:()=>void;
  const turn=new Promise<void>(resolve=>{release=resolve;});
  const tail=previous.then(()=>turn);
  locks.set(key,tail);
  await previous;
  try{return await withDatabase(work);}
  finally{release();if(locks.get(key)===tail)locks.delete(key);}
}
