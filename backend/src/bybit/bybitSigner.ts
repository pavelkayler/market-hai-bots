import crypto from 'node:crypto';

const DEFAULT_RECV_WINDOW = '5000';

export type BybitSignInput = {
  method: 'GET' | 'POST';
  apiKey: string;
  apiSecret: string;
  timestamp: number;
  recvWindow?: string;
  queryString?: string;
  body?: string;
};

export const buildBybitV5Headers = (input: BybitSignInput): Record<string, string> => {
  const recvWindow = input.recvWindow ?? DEFAULT_RECV_WINDOW;
  const payload = input.method === 'GET' ? input.queryString ?? '' : input.body ?? '';
  const raw = `${input.timestamp}${input.apiKey}${recvWindow}${payload}`;
  const sign = crypto.createHmac('sha256', input.apiSecret).update(raw).digest('hex');

  return {
    'X-BAPI-API-KEY': input.apiKey,
    'X-BAPI-TIMESTAMP': String(input.timestamp),
    'X-BAPI-RECV-WINDOW': recvWindow,
    'X-BAPI-SIGN': sign,
    'X-BAPI-SIGN-TYPE': '2'
  };
};
