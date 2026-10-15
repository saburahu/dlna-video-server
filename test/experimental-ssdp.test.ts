import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { ExperimentalSsdp } from "../src/experimental-ssdp.js";

test("experimental SSDP reply source is independent; LOCATION/USN unchanged; unknown ST ignored", async t => {
  const udn = "uuid:00000000-0000-4000-8000-000000000003", entries: { category: string; detail: any }[] = [];
  const ssdp = new ExperimentalSsdp(udn, "http://127.0.0.1:19092", (category, _, detail) => entries.push({ category, detail }));
  const ports = await ssdp.start("127.0.0.1", { listenPort: 0, multicast: false }); t.after(() => ssdp.stop(false));
  assert.notEqual(ports.receivePort, ports.replyPort);
  const client = dgram.createSocket("udp4"); t.after(() => client.close()); await new Promise<void>(resolve => client.bind(0, "127.0.0.1", resolve));
  const request = (st: string) => `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${st}\r\n\r\n`;
  const responses: { text: string; port: number }[] = []; client.on("message", (b, r) => responses.push({ text: b.toString(), port: r.port }));
  client.send(request("urn:schemas-upnp-org:device:MediaServer:1"), ports.receivePort, "127.0.0.1");
  for (let i = 0; i < 50 && !responses.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(responses.length, 1); assert.equal(responses[0].port, ports.replyPort); assert.match(responses[0].text, /LOCATION: http:\/\/127.0.0.1:19092\/upnp\/device.xml/);
  assert.ok(responses[0].text.includes(`${udn}::urn:schemas-upnp-org:device:MediaServer:1`));
  client.send(request("urn:unknown:device"), ports.receivePort, "127.0.0.1"); await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(responses.length, 1);
  client.send(request("ssdp:all"), ports.receivePort, "127.0.0.1");
  for (let i = 0; i < 50 && responses.length < 6; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(responses.length, 6); assert.ok(responses.every(r => r.port === ports.replyPort));
  assert.ok(entries.some(e => e.category === "SSDP_RESPONSE" && e.detail.error === null));
});
