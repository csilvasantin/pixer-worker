import {WorkerEntrypoint} from 'cloudflare:workers';
import {generateAnnouncement} from './announcement-tts.mjs';
import {generateAdvertisingImage} from './advertising-image.mjs';
import {startMedia,getMedia,storedAnnouncement} from './xpace-media.mjs';
export {default} from './index.js';
// No public route. Pages binds this entrypoint, never the full Worker.
export class AnnouncementTts extends WorkerEntrypoint {
  async generate(input) { return input?.archive ? storedAnnouncement(this.env,input,this.ctx) : generateAnnouncement(this.env,input); }
  async generateImage(input) { return input?.owner ? startMedia(this.env,{...input,kind:'image'},this.ctx) : generateAdvertisingImage(this.env,input); }
  async startVideo(input) { return startMedia(this.env,{...input,kind:'video'},this.ctx); }
  async getMedia(input) { return getMedia(this.env,input,this.ctx); }
}
