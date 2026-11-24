import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import {isPrivateAddress} from '../src/kernel/safe-fetch.js';

export function browserUrl(raw){
  if(typeof raw!=='string'||raw.length>8192||/[\u0000-\u0020\u007f]/.test(raw.trim()))throw Error('请输入有效的 HTTPS 网址');
  const value=raw.trim(),url=new URL(/^[a-z][a-z\d+.-]*:/i.test(value)?value:'https://'+value);
  const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||!host||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||!host.includes('.')&&!net.isIP(host))throw Error('仅支持公网 HTTPS 网页');
  if(net.isIP(host)&&!publicBrowserAddress(host))throw Error('内置浏览器不能访问本机或内网地址');
  return url.href;
}
export function publicBrowserAddress(address){
  if(isPrivateAddress(address))return false;
  if(net.isIPv4(address))return !/^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(address);
  // Restrict IPv6 to global unicast; mapped IPv4 and translation ranges are not needed here.
  return net.isIPv6(address)&&/^[23][\da-f]{0,3}:/i.test(address);
}

// Chromium's proxy connects to a validated numeric address. DNS is never
// resolved again between validation and connect, including redirects/subresources.
export async function createBrowserProxy({lookup=dns.lookup,connect=net.connect}={}){
  const sockets=new Set();let disposed=false,resolving=0;
  const track=socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));return socket;};
  const server=http.createServer((_req,res)=>{res.writeHead(403);res.end();});
  server.maxHeadersCount=32;server.headersTimeout=10000;server.requestTimeout=15000;
  server.on('clientError',(_error,socket)=>socket.destroy());
  server.on('connect',async(req,client,head)=>{
    track(client);client.pause();const fail=code=>{if(!client.destroyed)client.end(`HTTP/1.1 ${code} Forbidden\r\nConnection: close\r\n\r\n`);};
    if(disposed||sockets.size>128||head.length>65536){fail(403);return;}
    const deadline=setTimeout(()=>client.destroy(),10000);deadline.unref?.();
    try{
      if(!/^[^/?#@]+:443$/.test(req.url??''))throw Error('Invalid tunnel');
      const url=new URL(browserUrl('https://'+req.url)),host=url.hostname.replace(/^\[|\]$/g,'');
      let addresses;
      if(net.isIP(host))addresses=[{address:host,family:net.isIP(host)}];
      else{if(resolving>=32)throw Error('DNS busy');resolving++;const pending=Promise.resolve().then(()=>lookup(host,{all:true,verbatim:true})).finally(()=>resolving--);addresses=await Promise.race([pending,new Promise((_,reject)=>client.once('close',()=>reject(Error('Closed'))))]);}
      if(disposed||client.destroyed||!addresses.length||addresses.some(row=>!publicBrowserAddress(row.address)))throw Error('Private destination');
      const address=addresses.find(row=>row.family===4)||addresses[0];
      const upstream=track(connect({host:address.address,port:443,family:address.family}));
      client.once('close',()=>{clearTimeout(deadline);upstream.destroy();});
      upstream.once('error',()=>{clearTimeout(deadline);fail(502);});
      upstream.once('connect',()=>{
        clearTimeout(deadline);if(client.destroyed||disposed){upstream.destroy();return;}
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);
        client.pipe(upstream);upstream.pipe(client);client.resume();
      });
      upstream.once('end',()=>client.end());
    }catch{clearTimeout(deadline);fail(403);}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return{port:server.address().port,close(){if(disposed)return;disposed=true;for(const socket of sockets)socket.destroy();return new Promise(resolve=>server.close(resolve));}};
}
