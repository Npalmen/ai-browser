export interface CdpBoxModelQuad {
  content?: number[];
  padding?: number[];
  border?: number[];
  margin?: number[];
  width?: number;
  height?: number;
}

export interface CdpGetBoxModelResponse {
  model?: CdpBoxModelQuad;
}
