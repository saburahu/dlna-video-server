import { experimentalDidl, experimentalFormat, type ExperimentalMediaConfig } from "./experimental-media.js";
import { escapeXml } from "./core.js";

export type RendererAction = "GetTransportInfo" | "GetMediaInfo" | "SetAVTransportURI" | "Play" | "Seek";
export type RendererSoap = (action: RendererAction, args: Record<string, string>) => Promise<string>;
export const xmlValue = (xml: string, name: string) => new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([^<]*)<`, "i").exec(xml)?.[1] || "";
export function rendererSoap(control: string, record: (value: unknown) => void): RendererSoap {
  const url = new URL(control);
  if (url.protocol !== "http:" || !/^192\.168\.\d+\.\d+$/.test(url.hostname)) throw new Error("Renderer control must be on the private LAN");
  return async (action, args) => {
    const service = "urn:schemas-upnp-org:service:AVTransport:1";
    const body = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${Object.entries(args).map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`).join("")}</u:${action}></s:Body></s:Envelope>`;
    const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(8000), headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${service}#${action}"` }, body });
    let text = ""; for await (const chunk of response.body!) { text += Buffer.from(chunk).toString(); if (text.length > 65536) throw new Error("Renderer response too large"); }
    record({ at: new Date().toISOString(), action, status: response.status, request: body, response: text });
    if (!response.ok || /<(?:\w+:)?Fault\b/.test(text)) throw new Error(`${action} rejected: HTTP${response.status}, UPnP ${xmlValue(text, "errorCode")}: ${xmlValue(text, "errorDescription")}`);
    return text;
  };
}
/** Only the explicit run path sends setters. No Stop/Seek/normal server settings actions. */
export async function experimentalRendererTrial(config: ExperimentalMediaConfig, size: number, run: boolean, soap: RendererSoap, beginTrial: () => Promise<string>) {
  const transport = await soap("GetTransportInfo", { InstanceID: "0" });
  const state = xmlValue(transport, "CurrentTransportState");
  if (!run) return { state, playbackCommandsSent: false };
  if (!["STOPPED", "NO_MEDIA_PRESENT"].includes(state)) throw new Error(`TV not stopped: ${state || "unknown"}; no playback command sent`);
  const trialId = await beginTrial();
  const format = experimentalFormat(config);
  const didl = experimentalDidl(config, size, format.objectId, true);
  const uri = format.uri;
  await soap("SetAVTransportURI", { InstanceID: "0", CurrentURI: uri, CurrentURIMetaData: didl.wrap(didl.entries) });
  await soap("Play", { InstanceID: "0", Speed: "1" });
  return { state, trialId, uri, playbackCommandsSent: true, note: "SOAP success is not video/audio confirmation. Observe120s without seek; stop manually. Normal list playback remains unverified." };
}
