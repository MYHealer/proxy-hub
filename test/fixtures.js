/** 构造一个最小假适配器，用于测试 registry / sse / index */
export function fakeAdapter(id, models) {
  return {
    id,
    async getAuth() { return { token: 't', uid: '1' }; },
    async refreshAuth() { return { token: 't-new', uid: '1' }; },
    registerModels() {
      return models.map((m) => ({ externalId: `${id}-${m}`, upstreamId: m }));
    },
    async chat(reqBody, emit) {
      emit({ id: 'chunk1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] });
      emit({ id: 'chunk2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    },
  };
}
