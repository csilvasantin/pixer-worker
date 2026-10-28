// Shared, side-effect-free sprite contract. Kept identical in Store, XpaceOS and API.
export const SPRITE_SCHEMA='admira.sprite/1';
export const FACING=['front-right','front-left','back-left','back-right'];
const fail=message=>{throw new Error(message);};
const integer=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max;
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function spritePlacement(value){
 const fp=value?.fp,ph=value?.ph;
 if(!Array.isArray(fp)||fp.length!==2||!fp.every(n=>Number.isFinite(n)&&n>=1&&n<=6)||!Number.isFinite(ph)||ph<12||ph>200)fail('sprite-placement');
 return {fp:[...fp],ph};
}
export function normalizeSprite(value,size){
 if(!value||value.schema!==SPRITE_SCHEMA||JSON.stringify(value).length>32768)fail('sprite-schema');
 const {frames,frameW,frameH}=value,image=value.image,rect=value.contentRect,anchor=value.anchor,source=value.source;
 if(![1,4].includes(frames)||!integer(frameW,1,4096)||!integer(frameH,1,4096)||!image||image.width!==frames*frameW||image.height!==frameH||image.width*image.height>16777216||image.mime!=='image/png')fail('sprite-dimensions');
 if(size&&(size.width!==image.width||size.height!==image.height))fail('sprite-image-mismatch');
 if(!Array.isArray(value.facing)||value.facing.length!==frames||value.facing.some((f,i)=>frames===4?f!==FACING[i]:!FACING.includes(f)))fail('sprite-facing');
 if(!rect||!integer(rect.x,0,frameW-1)||!integer(rect.y,0,frameH-1)||!integer(rect.width,1,frameW)||!integer(rect.height,1,frameH)||rect.x+rect.width>frameW||rect.y+rect.height>frameH)fail('sprite-content-rect');
 if(!anchor||anchor.x!==.5||anchor.y!==1)fail('sprite-anchor');
 if(!source||![1,4].includes(source.frames)||!integer(source.width,1,16384)||!integer(source.height,1,16384)||source.width*source.height>16777216||source.frameW*source.frames!==source.width||!integer(source.frameW,1,16384)||frames===4&&source.frames!==4)fail('sprite-source');
 if(source.rgbaSha256!=null&&!sha(source.rgbaSha256))fail('sprite-source-hash');
 if(image.sha256!=null&&!sha(image.sha256))fail('sprite-image-hash');
 if(size?.sha256&&image.sha256&&size.sha256!==image.sha256)fail('sprite-image-hash-mismatch');
 const palette=value.palette;
 if(!palette||!['original','auto','custom'].includes(palette.mode)||palette.transparency!=='preserve-alpha')fail('sprite-palette');
 if(palette.mode!=='original'&&(![8,16,32].includes(palette.limit)||!Array.isArray(palette.colors)||!palette.colors.length||palette.colors.length>palette.limit||palette.colors.some(c=>!/^#[a-f0-9]{6}$/i.test(c))))fail('sprite-palette');
 const out={schema:SPRITE_SCHEMA,image:{mime:'image/png',width:image.width,height:image.height},frames,frameW,frameH,facing:[...value.facing],anchor:{x:.5,y:1},contentRect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},source:{width:source.width,height:source.height,frames:source.frames,frameW:source.frameW},palette:{mode:palette.mode,limit:palette.mode==='original'?null:palette.limit,colors:palette.mode==='original'?null:[...palette.colors],transparency:'preserve-alpha'}};
 if(source.rgbaSha256)out.source.rgbaSha256=source.rgbaSha256;
 if(size?.sha256||image.sha256)out.image.sha256=size?.sha256||image.sha256;
 return out;
}
export function spriteFields(item){
 const out={};if(item?.sprite)out.sprite=normalizeSprite(item.sprite);
 if(item?.localOnly===true)out.localOnly=true;
 for(const k of ['sourceAssetId','inventoryAssetId'])if(typeof item?.[k]==='string')out[k]=item[k];
 return out;
}
export function pngSize(bytes){
 const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
 if(b.length<33||![137,80,78,71,13,10,26,10].every((n,i)=>b[i]===n)||String.fromCharCode(...b.subarray(12,16))!=='IHDR')fail('sprite-png');
 const v=new DataView(b.buffer,b.byteOffset,b.byteLength),width=v.getUint32(16),height=v.getUint32(20);
 if(v.getUint32(8)!==13)fail('sprite-png');let pos=8,idat=0,ended=false;while(pos+12<=b.length){const n=v.getUint32(pos);if(n>b.length-pos-12)fail('sprite-png');const kind=String.fromCharCode(...b.subarray(pos+4,pos+8));let crc=0xffffffff;for(let i=pos+4;i<pos+8+n;i++){crc^=b[i];for(let k=0;k<8;k++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}if(((crc^0xffffffff)>>>0)!==v.getUint32(pos+8+n))fail('sprite-png-crc');if(kind==='IDAT')idat+=n;pos+=n+12;if(kind==='IEND'){if(n||pos!==b.length)fail('sprite-png');ended=true;break;}}if(!ended||!idat)fail('sprite-png');
 if(!integer(width,1,16384)||!integer(height,1,16384)||width*height>16777216)fail('sprite-png-size');
 return {width,height};
}
export async function bindSprite(value,bytes){
 const size=pngSize(bytes),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
 return normalizeSprite(value,{...size,sha256:hash});
}
export function originalSprite(bytes,frames=1){
 const image={...pngSize(bytes),mime:'image/png'},frameW=image.width/frames;
 return normalizeSprite({schema:SPRITE_SCHEMA,image,frames,frameW,frameH:image.height,facing:frames===4?[...FACING]:[FACING[0]],anchor:{x:.5,y:1},contentRect:{x:0,y:0,width:frameW,height:image.height},source:{width:image.width,height:image.height,frames,frameW},palette:{mode:'original',limit:null,colors:null,transparency:'preserve-alpha'}});
}
export function goodSpriteGeometry(sprite,{rot=0,fw,fd,ph,tileW,wallH}){
 const face=sprite.frames===4?((rot%4)+4)%4:0;if(!Number.isInteger(face))fail('sprite-rotation');
 const rect=sprite.contentRect,refWidth=tileW*.62*Math.sqrt(Math.max(.36,fw*fd))*Math.max(.4,Math.min(2.4,ph/46));
 const height=Math.max(12,Math.min(wallH*.85,refWidth/(sprite.source.frameW/sprite.source.height))),scale=height/rect.height;
 return {face,sx:face*sprite.frameW+rect.x,sy:rect.y,sw:rect.width,sh:rect.height,dx:-(sprite.anchor.x*sprite.frameW-rect.x)*scale,dy:-(sprite.anchor.y*sprite.frameH-rect.y)*scale,width:rect.width*scale,height};
}
