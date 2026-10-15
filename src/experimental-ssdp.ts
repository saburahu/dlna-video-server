import dgram from "node:dgram";
import { CD_SERVICE, CM_SERVICE } from "./upnp.js";
import type { ExperimentLog } from "./experimental-media.js";

/** Experimental only: preserve advertisement/header behavior, isolate unicast response endpoint. */
export class ExperimentalSsdp {
  private receive?: dgram.Socket;
  private replies?: dgram.Socket;
  private timers: NodeJS.Timeout[] = [];
  constructor(private udn: string, private location: string, private log: ExperimentLog) {}
  private targets() {
    return [["upnp:rootdevice", `${this.udn}::upnp:rootdevice`], [this.udn, this.udn],
      ...["urn:schemas-upnp-org:device:MediaServer:1", CD_SERVICE, CM_SERVICE].map(target => [target, `${this.udn}::${target}`])];
  }
  async start(address: string, options: { listenPort?: number; multicast?: boolean } = {}) {
    const multicast = options.multicast !== false;
    this.receive = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.replies = dgram.createSocket("udp4");
    for (const socket of [this.receive, this.replies]) socket.on("error", error => this.log("ERROR", "Experimental SSDP socket error", String(error)));
    try {
      await this.bind(this.replies, 0, address);
      await this.bind(this.receive, options.listenPort ?? 1900, multicast ? "0.0.0.0" : address);
      if (multicast) {
        this.receive.addMembership("239.255.255.250", address);
        this.receive.setMulticastInterface(address); this.receive.setMulticastTTL(2); this.receive.setMulticastLoopback(true);
      }
      this.receive.on("message", (message, remote) => {
        const text = message.toString(); if (!/^M-SEARCH \* HTTP\/1\.1/im.test(text)) return;
        const st = /^ST:\s*(.+)$/im.exec(text)?.[1].trim() || "upnp:rootdevice";
        this.log("SSDP", `M-SEARCH ${remote.address}`, { request: text, remotePort: remote.port });
        for (const [target, usn] of this.targets().filter(([target]) => st === "ssdp:all" || target.toLowerCase() === st.toLowerCase())) {
          const packet = `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT:\r\nLOCATION: ${this.location}/upnp/device.xml\r\nSERVER: Node.js UPnP/1.0 DMS/1.50\r\nST: ${target}\r\nUSN: ${usn}\r\n\r\n`;
          const sourcePort = this.replies!.address().port;
          this.replies!.send(packet, remote.port, remote.address, error => this.log(error ? "ERROR" : "SSDP_RESPONSE", "Experimental unicast response", { destination: remote.address, destinationPort: remote.port, sourcePort, packet, error: error && String(error), note: "send callback does not prove TV receipt" }));
        }
      });
      if (multicast) {
        this.notify("ssdp:alive");
        this.timers.push(setTimeout(() => this.notify("ssdp:alive"), 1000), setTimeout(() => this.notify("ssdp:alive"), 3000), setInterval(() => this.notify("ssdp:alive"), 15 * 60_000));
      }
      this.log("SSDP", "Experimental advertisement started with separate reply socket", { address, receivePort: this.receive.address().port, replyPort: this.replies.address().port });
      return { receivePort: this.receive.address().port, replyPort: this.replies.address().port };
    } catch (error) { this.stop(false); throw error; }
  }
  private bind(socket: dgram.Socket, port: number, address: string) {
    return new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.bind(port, address, () => { socket.removeListener("error", reject); resolve(); }); });
  }
  private notify(nts: string) {
    for (const [nt, usn] of this.targets()) this.receive?.send(`NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: ${this.location}/upnp/device.xml\r\nNT: ${nt}\r\nNTS: ${nts}\r\nSERVER: Node.js UPnP/1.0 DMS/1.50\r\nUSN: ${usn}\r\n\r\n`, 1900, "239.255.255.250");
  }
  stop(advertise = true) {
    if (advertise) this.notify("ssdp:byebye");
    for (const timer of this.timers) clearTimeout(timer); this.timers = [];
    for (const socket of [this.receive, this.replies]) { try { socket?.close(); } catch {} }
    this.receive = undefined; this.replies = undefined;
  }
}
