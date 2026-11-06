// A stand-in for sherpa-onnx (GLANCE_TEST_ASR), so tests never load the real
// model. It "hears" a fixed text, or reports what it was given.
// FAKE_ASR_TEXT: the text to return ("" for silence); default describes the
// audio and the hotwords. FAKE_ASR_FAIL_LOAD=1: the model fails to load.
export function create({ modelDir, bpeVocab }) {
  if (process.env.FAKE_ASR_FAIL_LOAD) throw new Error("fake model failed to load");
  return {
    decode(samples, hotwords) {
      if (process.env.FAKE_ASR_TEXT !== undefined) return process.env.FAKE_ASR_TEXT;
      return `heard ${samples.length} samples${hotwords ? ` hotwords=${hotwords}` : ""}${bpeVocab ? " vocab" : ""} from ${modelDir}`;
    },
  };
}
