import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import opaque from '@serenity-kit/opaque';
import { firstValueFrom } from 'rxjs';

export interface Kept2OpaqueLoginResult {
  userIdentifier: string;
  exportKey: string;
  sessionKey: string;
  sessionKeyHash: string;
}

@Injectable({ providedIn: 'root' })
export class Kept2OpaqueAuthService {
  private apiUrl = '/api';

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

  async login(userIdentifier: string, password: string): Promise<Kept2OpaqueLoginResult> {
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
    const result = await firstValueFrom(this.http.post<{ ok: boolean; userIdentifier: string; sessionKeyHash: string }>(
      `${this.apiUrl}/v2/opaque/login/finish`,
      {
        loginId: login.loginId,
        finishLoginRequest: finished.finishLoginRequest
      }
    ));
    return {
      userIdentifier: result.userIdentifier,
      exportKey: finished.exportKey,
      sessionKey: finished.sessionKey,
      sessionKeyHash: result.sessionKeyHash
    };
  }
}
