export {
  detectsBillFeature,
  detectsConnectionFeature,
  handleElectricityTurn,
  isElectricityActive,
  parseElectricityState,
  serializeElectricityState,
} from './flow.js'
export { parseBillTextFallback, readBillFromImage, readBillFromText, applyBillCorrection, parseBillOcrJson, reconcileReading } from './billOcr.js'
export {
  estimateNextBill,
  estimateSentence,
  usageChangeSentence,
  chartAscii,
  mergeHistory,
  mergeHistoryForService,
  normalizeServiceNo,
  readingToHistoryPoint,
  forecastEnabled,
  MIN_HISTORY_FOR_ESTIMATE,
} from './billMath.js'
export { explainAllCharges, explainCharge, matchCharge } from './charges.js'
export { ELECTRICITY_KB, matchKbRecord, canonicalizeLabel, explainFromKb } from './kb.js'
export { buildFirstBillReply, answerChargeQuestion, userFacingField } from './kbExplain.js'
export {
  findNearestPole,
  isInsideTelangana,
  parseConnectionType,
  parseLoadKw,
  parseLocationFromText,
  suggestLoadFromAppliances,
  estimateConnectionCost,
  materialsForConnection,
  nextStepsCopy,
  poleDataEnabled,
  costTablesEnabled,
  CONNECTION_CONTACTS,
} from './newConnection.js'
export type {
  BillReading,
  BillFlowState,
  ConnectionFlowState,
  ElectricityState,
  ElectricityTurnResult,
  ElectricityUiPayload,
  GeoPoint,
  GuideLang,
} from './types.js'
