import { DATABASE, ENV } from '../config/env';
import type { WorkerContext } from '../config/context';
import type {
    ChatAgentRequest,
    HistoryItem,
    LlmModifier,
    LlmRequestParams,
} from './types';

/**
 * @returns {(function(string): number)}
 */
function tokensCounter(): (text: string) => number {
    return (text) => {
        return text.length;
    };
}

async function loadHistory(key: string): Promise<HistoryItem[]> {
    // 加载历史记录
    let history = [];
    try {
        history = JSON.parse(await DATABASE.get(key));
    } catch (e) {
        console.error(e);
    }
    if (!history || !Array.isArray(history)) {
        history = [];
    }

    const counter = tokensCounter();

    const trimHistory = (list: HistoryItem[], initLength: number, maxLength: number, maxToken: number) => {
    // 历史记录超出长度需要裁剪, 小于0不裁剪
        if (maxLength >= 0 && list.length > maxLength) {
            list = list.splice(list.length - maxLength);
        }
        // 处理token长度问题, 小于0不裁剪
        if (maxToken > 0) {
            let tokenLength = initLength;
            for (let i = list.length - 1; i >= 0; i--) {
                const historyItem = list[i];
                let length = 0;
                if (historyItem.content) {
                    length = counter(historyItem.content);
                } else {
                    historyItem.content = '';
                }
                // 如果最大长度超过maxToken,裁剪history
                tokenLength += length;
                if (tokenLength > maxToken) {
                    list = list.splice(i + 1);
                    break;
                }
            }
        }
        return list;
    };

    // 裁剪
    if (ENV.AUTO_TRIM_HISTORY && ENV.MAX_HISTORY_LENGTH > 0) {
        history = trimHistory(history, 0, ENV.MAX_HISTORY_LENGTH, ENV.MAX_TOKEN_LENGTH);
    }

    return history;
}

type StreamResultHandler = (text: string) => Promise<any>;

export async function requestCompletionsFromLLM(params: LlmRequestParams, context: WorkerContext, llm: ChatAgentRequest, modifier: LlmModifier, onStream: StreamResultHandler): Promise<string> {
    const historyDisable = ENV.AUTO_TRIM_HISTORY && ENV.MAX_HISTORY_LENGTH <= 0;
    const historyKey = context.SHARE_CONTEXT.chatHistoryKey;
    let history = await loadHistory(historyKey);
    if (modifier) {
        const modifierData = modifier(history, params.message);
        history = modifierData.history;
        params.message = modifierData.message;
    }
    const llmParams = {
        ...params,
        history,
        prompt: context.USER_CONFIG.SYSTEM_INIT_MESSAGE,
    };
    const answer = await llm(llmParams, context, onStream);
    if (!historyDisable) {
        const userMessage = { role: 'user', content: params.message || '', images: params.images };
        if (ENV.HISTORY_IMAGE_PLACEHOLDER && userMessage.images && userMessage.images.length > 0) {
            delete userMessage.images;
            userMessage.content = `${ENV.HISTORY_IMAGE_PLACEHOLDER}\n${userMessage.content}`;
        }
        history.push(userMessage);
        history.push({ role: 'assistant', content: answer });
        await DATABASE.put(historyKey, JSON.stringify(history)).catch(console.error);
    }
    return answer;
}
