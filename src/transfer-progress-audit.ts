export interface TransferProgress {elapsedMs:number;bodyBytesEnqueued:number;socketBytesWrittenIncludingHeaders:number;writableLength:number;needDrain:boolean;sourceEof:boolean;completed?:boolean}
/** Local writable progress only: TCP ACK, zero-window, FIN/RST and receiver decode remain unknown. */
export function compareTransferProgress(previous:TransferProgress,current:TransferProgress){
 const elapsedMs=current.elapsedMs-previous.elapsedMs,bodyDelta=current.bodyBytesEnqueued-previous.bodyBytesEnqueued,socketDelta=current.socketBytesWrittenIncludingHeaders-previous.socketBytesWrittenIncludingHeaders;
 const state=elapsedMs<=0||bodyDelta<0||socketDelta<0?'invalid-or-reset':current.completed?'response-finished':socketDelta>0?'local-socket-progress':current.needDrain||current.writableLength>0?'local-backpressure-without-socket-progress':current.sourceEof?'source-eof-awaiting-response-finish':'no-observed-producer-or-socket-progress';
 return {elapsedMs,bodyDelta,socketDelta,state,tcpCause:'unknown',receiverDecode:'unknown'};
}
