import dgram from "node:dgram";
import { escapeXml, formatDuration, mediaSize, Profile, protocolInfo } from "./core.js";
import { Program, settings, systemUpdateId } from "./store.js";

import { metadataDisplay } from "./recording-metadata.js";

export const CD_SERVICE = "urn:schemas-upnp-org:service:ContentDirectory:1";
export const CM_SERVICE = "urn:schemas-upnp-org:service:ConnectionManager:1";

export function deviceXml(baseUrl: string): string {
  return `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0">
 <specVersion><major>1</major><minor>0</minor></specVersion><URLBase>${escapeXml(baseUrl)}/</URLBase>
 <device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
 <friendlyName>${escapeXml(settings.friendlyName)}</friendlyName>
 <manufacturer>Local Recording Server Project</manufacturer>
 <modelDescription>Network TV Recording Media Server</modelDescription>
 <modelName>DLNA Video Server</modelName><modelNumber>0.1</modelNumber>
 <serialNumber>${escapeXml(settings.udn.replace("uuid:", "").slice(0, 12))}</serialNumber><UDN>${settings.udn}</UDN>
 <dlna:X_DLNADOC>DMS-1.50</dlna:X_DLNADOC>
 <serviceList>
  <service><serviceType>${CD_SERVICE}</serviceType><serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId><SCPDURL>/upnp/content-directory.xml</SCPDURL><controlURL>/upnp/control/content-directory</controlURL><eventSubURL>/upnp/event/content-directory</eventSubURL></service>
  <service><serviceType>${CM_SERVICE}</serviceType><serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId><SCPDURL>/upnp/connection-manager.xml</SCPDURL><controlURL>/upnp/control/connection-manager</controlURL><eventSubURL>/upnp/event/connection-manager</eventSubURL></service>
 </serviceList></device></root>`;
}

export function scpd(kind: "cd" | "cm"): string {
  if (kind === "cd") return `<?xml version="1.0"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
 <specVersion><major>1</major><minor>0</minor></specVersion>
 <actionList>
  <action><name>Browse</name><argumentList>
   <argument><name>ObjectID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ObjectID</relatedStateVariable></argument>
   <argument><name>BrowseFlag</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_BrowseFlag</relatedStateVariable></argument>
   <argument><name>Filter</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Filter</relatedStateVariable></argument>
   <argument><name>StartingIndex</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Index</relatedStateVariable></argument>
   <argument><name>RequestedCount</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
   <argument><name>SortCriteria</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SortCriteria</relatedStateVariable></argument>
   <argument><name>Result</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Result</relatedStateVariable></argument>
   <argument><name>NumberReturned</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
   <argument><name>TotalMatches</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Count</relatedStateVariable></argument>
   <argument><name>UpdateID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_UpdateID</relatedStateVariable></argument>
  </argumentList></action>
  <action><name>GetSearchCapabilities</name><argumentList><argument><name>SearchCaps</name><direction>out</direction><relatedStateVariable>SearchCapabilities</relatedStateVariable></argument></argumentList></action>
  <action><name>GetSortCapabilities</name><argumentList><argument><name>SortCaps</name><direction>out</direction><relatedStateVariable>SortCapabilities</relatedStateVariable></argument></argumentList></action>
  <action><name>GetSystemUpdateID</name><argumentList><argument><name>Id</name><direction>out</direction><relatedStateVariable>SystemUpdateID</relatedStateVariable></argument></argumentList></action>
 </actionList>
 <serviceStateTable>
  <stateVariable sendEvents="no"><name>A_ARG_TYPE_ObjectID</name><dataType>string</dataType></stateVariable>
  <stateVariable sendEvents="no"><name>A_ARG_TYPE_Result</name><dataType>string</dataType></stateVariable>
  <stateVariable sendEvents="no"><name>A_ARG_TYPE_BrowseFlag</name><dataType>string</dataType><allowedValueList><allowedValue>BrowseMetadata</allowedValue><allowedValue>BrowseDirectChildren</allowedValue></allowedValueList></stateVariable>
  <stateVariable sendEvents="no"><name>A_ARG_TYPE_Filter</name><dataType>string</dataType></stateVariable>
  <stateVariable sendEvents="no"><name>A_ARG_TYPE_SortCriteria</name><dataType>string</dataType></stateVariable>
  <stateVariable sendEvents="no"><name>A_ARG_TYPE_Index</name><dataType>ui4</dataType></stateVariable>
  <stateVariable sendEvents="no"><name>A_ARG_TYPE_Count</name><dataType>ui4</dataType></stateVariable>
  <stateVariable sendEvents="no"><name>A_ARG_TYPE_UpdateID</name><dataType>ui4</dataType></stateVariable>
  <stateVariable sendEvents="no"><name>SearchCapabilities</name><dataType>string</dataType></stateVariable>
  <stateVariable sendEvents="no"><name>SortCapabilities</name><dataType>string</dataType></stateVariable>
  <stateVariable sendEvents="yes"><name>SystemUpdateID</name><dataType>ui4</dataType></stateVariable>
 </serviceStateTable>
</scpd>`;
  return `<?xml version="1.0"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
 <specVersion><major>1</major><minor>0</minor></specVersion>
 <actionList>
  <action><name>GetProtocolInfo</name><argumentList>
   <argument><name>Source</name><direction>out</direction><relatedStateVariable>SourceProtocolInfo</relatedStateVariable></argument>
   <argument><name>Sink</name><direction>out</direction><relatedStateVariable>SinkProtocolInfo</relatedStateVariable></argument>
  </argumentList></action>
  <action><name>GetCurrentConnectionIDs</name><argumentList><argument><name>ConnectionIDs</name><direction>out</direction><relatedStateVariable>CurrentConnectionIDs</relatedStateVariable></argument></argumentList></action>
  <action><name>GetCurrentConnectionInfo</name><argumentList>
   <argument><name>ConnectionID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ConnectionID</relatedStateVariable></argument>
   <argument><name>RcsID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_RcsID</relatedStateVariable></argument>
   <argument><name>AVTransportID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_AVTransportID</relatedStateVariable></argument>
   <argument><name>ProtocolInfo</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ProtocolInfo</relatedStateVariable></argument>
   <argument><name>PeerConnectionManager</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionManager</relatedStateVariable></argument>
   <argument><name>PeerConnectionID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionID</relatedStateVariable></argument>
   <argument><name>Direction</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Direction</relatedStateVariable></argument>
   <argument><name>Status</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionStatus</relatedStateVariable></argument>
  </argumentList></action>
 </actionList>
 <serviceStateTable>
  <stateVariable sendEvents="yes"><name>SourceProtocolInfo</name><dataType>string</dataType></stateVariable>
  <stateVariable sendEvents="yes"><name>SinkProtocolInfo</name><dataType>string</dataType></stateVariable>
  <stateVariable sendEvents="yes"><name>CurrentConnectionIDs</name><dataType>string</dataType></stateVariable>
  <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionStatus</name><dataType>string</dataType><allowedValueList><allowedValue>OK</allowedValue><allowedValue>ContentFormatMismatch</allowedValue><allowedValue>InsufficientBandwidth</allowedValue><allowedValue>UnreliableChannel</allowedValue><allowedValue>Unknown</allowedValue></allowedValueList></stateVariable>
  <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionManager</name><dataType>string</dataType></stateVariable>
  <stateVariable sendEvents="no"><name>A_ARG_TYPE_Direction</name><dataType>string</dataType><allowedValueList><allowedValue>Input</allowedValue><allowedValue>Output</allowedValue></allowedValueList></stateVariable>
  <stateVariable sendEvents="no"><name>A_ARG_TYPE_ProtocolInfo</name><dataType>string</dataType></stateVariable>
  <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionID</name><dataType>i4</dataType></stateVariable>
  <stateVariable sendEvents="no"><name>A_ARG_TYPE_AVTransportID</name><dataType>i4</dataType></stateVariable>
  <stateVariable sendEvents="no"><name>A_ARG_TYPE_RcsID</name><dataType>i4</dataType></stateVariable>
 </serviceStateTable>
</scpd>`;
}

const containers = [
  ["rec", "録画番組"], ["all", "すべて"], ["folders", "フォルダ別"]
];

function container(id: string, parent: string, title: string, children: number) {
  return `<container id="${id}" parentID="${parent}" restricted="1" childCount="${children}"><dc:title>${escapeXml(title)}</dc:title><upnp:class>object.container</upnp:class></container>`;
}
export type MediaResource = { url: string; size?: number; durationSeconds?: number; profile?: Profile; unavailable?: boolean };
export function browseRequest(body: string) {
  const get = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(body)?.[1] ?? '';
  return { objectId: get('ObjectID') || '0', start: Math.max(0, Number(get('StartingIndex')) || 0),
    count: Math.max(0, Number(get('RequestedCount')) || 0), metadata: get('BrowseFlag') === 'BrowseMetadata' };
}
export function browsePrograms(objectId: string, start: number, count: number, all: Program[], metadata = false) {
  const candidates = metadata && objectId.startsWith('item:')
    ? all.filter(p => `item:${p.id}` === objectId)
    : !metadata && containers.some(([id]) => id === objectId) && objectId !== 'rec' && objectId !== 'folders'
      ? all.filter(p => p.published) : [];
  return { total: candidates.length, selected: candidates.slice(start, count === 0 ? undefined : start + count) };
}
function item(p: Program, baseUrl: string, profile: Profile, resource?: MediaResource) {
  const display = metadataDisplay(p);
  if(resource?.unavailable) return `<item id="item:${p.id}" parentID="all" restricted="1"><dc:title>${escapeXml(display.title)}</dc:title><upnp:class>${profile.itemClass}</upnp:class></item>`;
  const url = resource?.url ?? `${baseUrl}/media/${p.id}/${encodeURIComponent(p.title)}.ts`;
  const size = resource ? resource.size : mediaSize(p.size, profile);
  profile = resource?.profile ?? profile;
  const duration=resource?.durationSeconds??p.duration;
  const preciseMs=resource?.durationSeconds===undefined?undefined:Math.round(resource.durationSeconds*1000);
  const durationText=preciseMs===undefined?formatDuration(duration):formatDuration(preciseMs/1000).replace(/\.000$/,'.'+String(preciseMs%1000).padStart(3,'0'));
  return `<item id="item:${p.id}" parentID="all" restricted="1"><dc:title>${escapeXml(display.title)}</dc:title><upnp:class>${profile.itemClass}</upnp:class><dc:date>${escapeXml(display.date)}</dc:date>${display.description ? `<dc:description>${escapeXml(display.description)}</dc:description>` : ""}${display.genre ? `<upnp:genre>${escapeXml(display.genre)}</upnp:genre>` : ""}${p.station ? `<upnp:channelName>${escapeXml(p.station)}</upnp:channelName>` : ""}<res protocolInfo="${escapeXml(protocolInfo(profile))}"${size!==undefined?` size="${size}"`:''}${duration ? ` duration="${durationText}"` : ""}>${escapeXml(url)}</res></item>`;
}
export function browseDIDL(objectId: string, start: number, count: number, all: Program[], baseUrl: string, profile: Profile, metadata = false, resources: ReadonlyMap<string, MediaResource> = new Map()) {
  let entries: string[] = [];
  const page = browsePrograms(objectId, start, count, all, metadata);
  if ((metadata && objectId.startsWith('item:')) || (!metadata && objectId !== 'rec' && objectId !== 'folders' && containers.some(([id]) => id === objectId))) {
    const selected = page.selected.map(p => item(p, baseUrl, profile, resources.get(p.id)));
    const didl = `<?xml version="1.0"?><DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${selected.join('')}</DIDL-Lite>`;
    return { didl, numberReturned: selected.length, total: page.total };
  }
  if (metadata && objectId === "0") entries = [container("0", "-1", settings.friendlyName, 1)];
  else if (metadata && objectId === "rec") entries = [container("rec", "0", "録画番組", containers.length-1)];
  else if (metadata && containers.some(([id]) => id === objectId)) {
    const title = containers.find(([id]) => id === objectId)?.[1] || objectId;
    entries = [container(objectId, objectId === "rec" ? "0" : "rec", title, all.length)];
  }
  else if (metadata && objectId.startsWith("item:")) {
    const p = all.find(x => `item:${x.id}` === objectId);
    entries = p ? [item(p, baseUrl, profile, resources.get(p.id))] : [];
  }
  else if (objectId === "0") entries = [container("rec", "0", "録画番組", containers.length-1)];
  else if (objectId === "rec") entries = containers.slice(1).map(([id, title]) => container(id, "rec", title, id==='folders'?0:all.length));
  else if(objectId==='folders')entries=[];
  else if (containers.some(([id]) => id === objectId)) entries = all.filter(p => p.published).map(p => item(p, baseUrl, profile, resources.get(p.id)));
  const total = entries.length;
  const selected = entries.slice(start, count === 0 ? undefined : start + count);
  const didl = `<?xml version="1.0"?><DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">${selected.join("")}</DIDL-Lite>`;
  return { didl, numberReturned: selected.length, total };
}
function soapEnvelope(body: string) {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${body}</s:Body></s:Envelope>`;
}
export function soapResponse(action: string, body: string, baseUrl: string, programs: Program[], profile: Profile, resources: ReadonlyMap<string, MediaResource> = new Map()) {
  if (action === "Browse") {
    const { objectId, start, count, metadata } = browseRequest(body);
    const r = browseDIDL(objectId, start, count, programs, baseUrl, profile, metadata, resources);
    return soapEnvelope(`<u:BrowseResponse xmlns:u="${CD_SERVICE}"><Result>${escapeXml(r.didl)}</Result><NumberReturned>${r.numberReturned}</NumberReturned><TotalMatches>${r.total}</TotalMatches><UpdateID>${systemUpdateId}</UpdateID></u:BrowseResponse>`);
  }
  if (action === "GetSystemUpdateID") return soapEnvelope(`<u:GetSystemUpdateIDResponse xmlns:u="${CD_SERVICE}"><Id>${systemUpdateId}</Id></u:GetSystemUpdateIDResponse>`);
  if (action === "GetSearchCapabilities") return soapEnvelope(`<u:GetSearchCapabilitiesResponse xmlns:u="${CD_SERVICE}"><SearchCaps></SearchCaps></u:GetSearchCapabilitiesResponse>`);
  if (action === "GetSortCapabilities") return soapEnvelope(`<u:GetSortCapabilitiesResponse xmlns:u="${CD_SERVICE}"><SortCaps>dc:title,dc:date</SortCaps></u:GetSortCapabilitiesResponse>`);
  if (action === "GetProtocolInfo") {
    const source = [...new Set([protocolInfo(profile), ...[...resources.values()].map(r => protocolInfo(r.profile ?? profile))])].join(',');
    return soapEnvelope(`<u:GetProtocolInfoResponse xmlns:u="${CM_SERVICE}"><Source>${escapeXml(source)}</Source><Sink></Sink></u:GetProtocolInfoResponse>`);
  }
  if (action === "GetCurrentConnectionIDs") return soapEnvelope(`<u:GetCurrentConnectionIDsResponse xmlns:u="${CM_SERVICE}"><ConnectionIDs></ConnectionIDs></u:GetCurrentConnectionIDsResponse>`);
  return soapEnvelope(`<u:GetCurrentConnectionInfoResponse xmlns:u="${CM_SERVICE}"><RcsID>-1</RcsID><AVTransportID>-1</AVTransportID><ProtocolInfo></ProtocolInfo><PeerConnectionManager></PeerConnectionManager><PeerConnectionID>-1</PeerConnectionID><Direction>Output</Direction><Status>Unknown</Status></u:GetCurrentConnectionInfoResponse>`);
}

export class SsdpServer {
  private socket?: dgram.Socket;
  private timer?: NodeJS.Timeout;
  private announceTimers: NodeJS.Timeout[] = [];
  constructor(private location: () => string, private log: (c: string, m: string, d?: unknown) => void) {}
  start(address: string) {
    this.stop();
    const socket = this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.on("message", (msg, rinfo) => {
      const text = msg.toString();
      if (!/^M-SEARCH \* HTTP\/1\.1/im.test(text)) return;
      this.log("SSDP", `M-SEARCH ${rinfo.address}`, text);
      const st = /^ST:\s*(.+)$/im.exec(text)?.[1].trim() || "upnp:rootdevice";
      this.sendResponse(rinfo, st);
    });
    socket.on("error", e => this.log("ERROR", "SSDPエラー", String(e)));
    socket.bind(1900, "0.0.0.0", () => {
      try {
        socket.addMembership("239.255.255.250", address);
        socket.setMulticastInterface(address);
        socket.setMulticastTTL(2);
        socket.setMulticastLoopback(true);
      } catch (e) { this.log("ERROR", "SSDP参加失敗", String(e)); }
      this.notify("ssdp:alive");
      // Some older TVs only listen passively and can miss a single startup burst.
      this.announceTimers.push(
        setTimeout(() => this.notify("ssdp:alive"), 1000),
        setTimeout(() => this.notify("ssdp:alive"), 3000)
      );
      this.timer = setInterval(() => this.notify("ssdp:alive"), 15 * 60_000);
      this.log("SSDP", `広告開始 ${address}:1900`, `LOCATION: ${this.location()}/upnp/device.xml`);
    });
  }
  private targets() {
    return [
      ["upnp:rootdevice", `${settings.udn}::upnp:rootdevice`], [settings.udn, settings.udn],
      ["urn:schemas-upnp-org:device:MediaServer:1", `${settings.udn}::urn:schemas-upnp-org:device:MediaServer:1`],
      [CD_SERVICE, `${settings.udn}::${CD_SERVICE}`], [CM_SERVICE, `${settings.udn}::${CM_SERVICE}`]
    ];
  }
  private sendResponse(to: dgram.RemoteInfo, st: string) {
    const matches = st === "ssdp:all"
      ? this.targets()
      : this.targets().filter(([target]) => target.toLowerCase() === st.toLowerCase());
    for (const found of matches) {
    const packet = `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT:\r\nLOCATION: ${this.location()}/upnp/device.xml\r\nSERVER: Node.js UPnP/1.0 DMS/1.50\r\nST: ${found[0]}\r\nUSN: ${found[1]}\r\n\r\n`;
    this.socket?.send(packet, to.port, to.address);
    }
  }
  notify(nts: "ssdp:alive" | "ssdp:byebye") {
    for (const [nt, usn] of this.targets()) {
      const packet = `NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: ${this.location()}/upnp/device.xml\r\nNT: ${nt}\r\nNTS: ${nts}\r\nSERVER: Node.js UPnP/1.0 DMS/1.50\r\nUSN: ${usn}\r\n\r\n`;
      this.socket?.send(packet, 1900, "239.255.255.250");
    }
  }
  stop() {
    if (this.socket) { try { this.notify("ssdp:byebye"); this.socket.close(); } catch {} }
    if (this.timer) clearInterval(this.timer);
    for (const timer of this.announceTimers) clearTimeout(timer);
    this.announceTimers = [];
    this.socket = undefined; this.timer = undefined;
  }
}
