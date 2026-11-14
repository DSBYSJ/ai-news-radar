import {parentPort,workerData} from 'node:worker_threads'
// 在导入配置之前指定已解析的数据库路径；不把凭据放进消息或结果。
process.env.DATABASE_PATH=workerData.dbPath
const {getDb}=await import('../db.ts')
const {runBackfill}=await import('./backfill.ts')
const db=getDb()
try{
  const report=await runBackfill(db,{days:workerData.days,windowDays:workerData.windowDays,apply:true})
  parentPort?.postMessage({ok:true,report})
}catch(error){parentPort?.postMessage({ok:false,error:String(error)})}
finally{db.close()}
