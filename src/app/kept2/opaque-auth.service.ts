import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import opaque from '@serenity-kit/opaque';
import { firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';

export interface Kept2OpaqueLoginResult {
  userIdentifier: string;
  accountId?: string;
  exportKey: string;
  sessionKey: string;
  sessionKeyHash: string;
  sessionToken?: string;
  expiresAt?: string;
}

@Injectable({ providedIn: 'root' })
export class Kept2OpaqueAuthService {
  private apiUrl = environment.apiUrl;

  constructor(private http: HttpClient) {}

  async serverPublicKey() {
    await opaque.ready;
    const response = await firstValueFrom(this.http.get<{ serverPublicKey: string }>(
      `${this.apiUrl}/v2/opaque/server-public-key`
    ));
    return response.serverPublicKey;
  }

  async register(userIdentifier: string, password: string) {
    await opaque.ready;
    const started = opaque.client.startRegistration({ password });
    const registration = await firstValueFrom(this.http.post<{ registrationResponse: string }>(
      `${this.apiUrl}/v2/opaque/registration-response`,
      {
        userIdentifier,
        registrationRequest: started.registrationRequest
      }
    ));
    const finished = opaque.client.finishRegistration({
      clientRegistrationState: started.clientRegistrationState,
      registrationResponse: registration.registrationResponse,
      password
    });
    await firstValueFrom(this.http.post<{ ok: boolean; userIdentifier: string }>(
      `${this.apiUrl}/v2/opaque/registration-record`,
      {
        userIdentifier,
        registrationRecord: finished.registrationRecord
      }
    ));
    return {
      userIdentifier,
      exportKey: finished.exportKey
    };
  }

  async login(userIdentifier: string, password: string, deviceLabel = ''): Promise<Kept2OpaqueLoginResult> {
    await opaque.ready;
    const started = opaque.client.startLogin({ password });
    const login = await firstValueFrom(this.http.post<{ loginId: string; loginResponse: string }>(
      `${this.apiUrl}/v2/opaque/login/start`,
      {
        userIdentifier,
        startLoginRequest: started.startLoginRequest
      }
    ));
    const finished = opaque.client.finishLogin({
      clientLoginState: started.clientLoginState,
      loginResponse: login.loginResponse,
      password
    });
    if (!finished) throw new Error('OPAQUE login failed.');
    const result = await firstValueFrom(this.http.post<{
      ok: boolean;
      userIdentifier?: string;
      accountId?: string;
      sessionKeyHash: string;
      sessionToken?: string;
      expiresAt?: string;
    }>(
      `${this.apiUrl}/v2/opaque/login/finish`,
      {
        loginId: login.loginId,
        finishLoginRequest: finished.finishLoginRequest,
        deviceLabel
      }
    ));
    return {
      userIdentifier: result.userIdentifier || userIdentifier,
      accountId: result.accountId,
      exportKey: finished.exportKey,
      sessionKey: finished.sessionKey,
      sessionKeyHash: result.sessionKeyHash,
      sessionToken: result.sessionToken,
      expiresAt: result.expiresAt
    };
  }
}
