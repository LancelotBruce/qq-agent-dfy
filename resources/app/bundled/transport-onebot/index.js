import { createOneBotProvider } from './provider.js';
import { createOneBotConnectionResolver } from './connection.js';
import { createFavoritesCapability } from './favorites.js';
export default {
  setup(ctx) {
    const config = ctx.capability('host.config');
    let active = null;
    let notifyFavorites=()=>{};
    const favorites=createFavoritesCapability({register:provider=>provider===null?ctx.unregisterCapability?.('qq.emoji-favorites'):ctx.registerCapability('qq.emoji-favorites',provider,{default:true}),changed:()=>notifyFavorites()});
    ctx.registerTransport({ id: 'onebot', default: true, scopes: ['net.outbound'],
      create({ onEvent, onStatus, signal, current = () => true }) {
        let instance;
        const provider = createOneBotProvider({ cfg: () => config.get(), log: ctx.log, onEvent, onStatus:state=>{onStatus?.(state);favorites.refresh(instance);},
          connectionResolver: createOneBotConnectionResolver(),
          transformSticker: input => ctx.capability('compat-04.transformSticker', input) ?? input.segments });
        const start = provider.start.bind(provider), stop = provider.stop.bind(provider);
        let offConfig = null, generation = 0, running = false, startPromise = null;
        instance = Object.assign(provider, {
          async start() {
            if (running) return;
            if (startPromise) return startPromise;
            if (signal?.aborted || !current()) return;
            const epoch = ++generation;
            active = instance;
            notifyFavorites=()=>{if(active===instance&&!signal?.aborted&&current())onStatus?.({...instance.status(),favoritesRevision:crypto.randomUUID()});};
            favorites.bind(instance,()=>!signal?.aborted&&current()&&active===instance);
            offConfig = config.onChange?.(() => {
              if (active === instance && epoch === generation && !signal?.aborted && current()) {provider.refreshConfig();favorites.refresh(instance);}
            }) ?? (() => {});
            startPromise = (async () => {
              try { await start(); if (epoch === generation && active === instance) {running = true;favorites.refresh(instance);} }
              catch (error) { if (epoch === generation) { offConfig?.(); offConfig = null; if (active === instance) {favorites.clear(instance);active = null;} } throw error; }
            })();
            try { await startPromise; } finally { if (epoch === generation) startPromise = null; }
          },
          async stop() {
            ++generation; running = false; startPromise = null;
            favorites.clear(instance);
            offConfig?.(); offConfig = null;
            if (active === instance) active = null;
            await stop();
          },
        });
        return instance;
      },
    });
    ctx.lifecycle.onStop(async()=>{favorites.clear();await active?.stop();});
  },
};
