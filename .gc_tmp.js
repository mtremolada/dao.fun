const {PublicKey}=require('@solana/web3.js');
const PID=new PublicKey('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');
const WSOL=new PublicKey('So11111111111111111111111111111111111111112');
function u16le(n){const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;}
const out=[];
for(const ct of [0,1,2]) for(const idx of [0,1,2,3]){
  const [pda]=PublicKey.findProgramAddressSync([Buffer.from('global_config'),WSOL.toBuffer(),Buffer.from([ct]),u16le(idx)],PID);
  out.push(`ct=${ct} idx=${idx} ${pda.toBase58()}`);
}
console.log(out.join('\n'));
