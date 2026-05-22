export type OtpChannel = 'sms' | 'email'

export type OtpDeliveryMode = 'console' | 'live'

export type OtpPurpose = 'login' | 'forgot_password'

export interface OtpSendPayload {
  code: string
  purpose: OtpPurpose
  appName: string
  ttlMinutes: number
}

export interface OtpSendResult {
  ok: true
  provider: string
  /** Present in console/test mode for API dev_code echo */
  loggedCode?: string
}

export interface OtpSendError {
  ok: false
  provider: string
  error: string
}

export type OtpChannelSendOutcome = OtpSendResult | OtpSendError

export interface OtpEmailProvider {
  readonly name: string
  send(to: string, payload: OtpSendPayload): Promise<OtpChannelSendOutcome>
}

export interface OtpSmsProvider {
  readonly name: string
  send(to: string, payload: OtpSendPayload): Promise<OtpChannelSendOutcome>
}

export interface OtpDeliveryStatus {
  mode: OtpDeliveryMode
  channels: OtpChannel[]
  email: { provider: string; configured: boolean; enabled: boolean }
  sms: { provider: string; configured: boolean; enabled: boolean }
}
