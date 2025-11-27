export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
};

export type tokenCallback = (t: TokenResponse, isRefresh?: boolean) => void;

export type Config = {
  APP_KEY: string;
  APP_SECRET: string;
  REDIRECT_URL: string;
  AUTHORIZATION_URL: string;
  TOKEN_URL: string;
  PORT: number;
  CALLBACK_PATH: string;
};

export type PKCEConfig = {
  APP_KEY: string;
  REDIRECT_URL: string;
  AUTHORIZATION_URL: string;
  TOKEN_URL: string;
  PORT: number;
  CALLBACK_PATH: string;
};

export type PKCEPair = {
  codeVerifier: string;
  codeChallenge: string;
};
