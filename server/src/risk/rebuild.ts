import {Worker} from 'node:worker_threads'
import {config} from '../config.ts'
import type {BackfillReport} from './backfill.ts'

let running=false
/** CPU 密集回算用独立线程；计算期间不持有写事务，主服务保持可响应。 */
export async function rebuildRiskHistory(opts:{days?:number;windowDays?:number}={}):Promise<BackfillReport>{
  if(running)throw new Error('已有风险历史重建任务运行，请稍后再试')
  running=true
  try{return await new Promise<BackfillReport>((resolve,reject)=>{
    const worker=new Worker(new URL('./recomputeWorker.ts',import.meta.url),{workerData:{dbPath:config.databasePath,days:opts.days??180,windowDays:opts.windowDays}})
    let settled=false
    worker.once('message',(message:{ok:boolean;report:BackfillReport;error?:string})=>{settled=true;message.ok?resolve(message.report):reject(new Error(message.error??'重建失败'))})
    worker.once('error',reject)
    worker.once('exit',code=>{if(!settled)reject(new Error(`历史重建线程意外退出（${code}）`))})
  })}finally{running=false}
}
