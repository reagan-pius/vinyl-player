/**
 * workletTypes.ts
 *
 * Shared contract between the main thread (React) and the
 * VinylProcessor AudioWorklet. The AudioParams declared in
 * `vinyl-processor.js` parameterDescriptors must match the keys here.
 */
export interface VinylParams {
  crackleIntensity: number; // 0..1  — surface crackle / pop rate
  wowFlutterDepth: number;   // 0..1  — wow/flutter modulation depth
  rumbleLevel: number;       // 0..1  — sub-bass rumble
  surfaceNoise: number;      // 0..1  — continuous hiss floor
  wearLevel: number;         // 0..1  — record wear (ties to many params)
  speed: number;             // 33 | 45 | 78  — affects HF roll-off & LFO rates
  wetDry: number;            // 0..1  — dry/wet mix of the vinyl DSP
  outputGain: number;        // 0..4  — post-DSP gain (UI caps at 2)
  /** 1 = deck live (music + noise), 0 = gated silent when paused/stopped. */
  deckActive: number;
}

export type VinylParamName = keyof VinylParams;
