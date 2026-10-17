import test from 'node:test';import assert from 'node:assert/strict';
import {PresenceClock,presenceBeat,presenceObservation} from '../src/presence-clock.mjs';
test('Fold heartbeat proof is ephemeral, matches supplied signature and adds no KV writes',async()=>{
 let writes=0;const clock=new PresenceClock({blockConcurrencyWhile:fn=>fn(),storage:{get:async()=>null,put:async()=>{writes++}}},{});
 const env={PRESENCE_CLOCK:{idFromName:()=>'',get:()=>({fetch:(url,options)=>clock.fetch(new Request(url,options))})}};
 await presenceBeat(env,'virtual-lab-admirito-fold',100000,'measured-a');
 assert.deepEqual(await presenceObservation(env,'virtual-lab-admirito-fold'),{ts:100000,fingerprint:'measured-a'});
 await presenceBeat(env,'virtual-lab-admirito-fold',110000,'measured-a');
 assert.equal((await presenceObservation(env,'virtual-lab-admirito-fold')).ts,110000);assert.equal(writes,1);
 await presenceBeat(env,'virtual-lab-admirito-fold',120000,'measured-b');assert.equal((await presenceObservation(env,'virtual-lab-admirito-fold')).fingerprint,'measured-b');
 assert.equal(await presenceObservation(env,'customer-screen'),null);
});
