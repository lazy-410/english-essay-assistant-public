package cn.kaoyan.essay.net;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 本地服务（嵌入式 Node，127.0.0.1:7654）的 HTTP 客户端。
 *
 * 统一处理 server.mjs 的响应外壳：成功 { ok:true, data:… }，失败 { ok:false, error, code }。
 * 回调一律投递到主线程；返回的 {@link Request} 可在页面销毁时 cancel，避免回调打到已卸载界面。
 */
public final class ApiClient {

    public static final String BASE_URL = "http://127.0.0.1:7654";

    /** 配置/状态类请求。 */
    public static final int TIMEOUT_QUICK = 15_000;
    /** 识别/校对类请求。 */
    public static final int TIMEOUT_NORMAL = 60_000;
    /** 作文生成、批改分析等多轮 AI 请求。 */
    public static final int TIMEOUT_GENERATE = 300_000;

    public interface Parser<T> {
        T parse(JSONObject data) throws Exception;
    }

    public interface Callback<T> {
        void onSuccess(T data);

        void onFailure(ApiError error);
    }

    /** NDJSON 流式接口（/api/compose/stream）的事件回调，全部投递到主线程。 */
    public interface StreamCallback {
        /** 一行一个 JSON 事件：start / step / round / done / error。 */
        void onEvent(JSONObject event);

        void onFailure(ApiError error);

        /** 连接正常结束（无论是否收到 done，调用方自行判断是否拿到成品）。 */
        void onFinished();
    }

    /** 一次请求的句柄：界面销毁时取消。 */
    public static final class Request {
        private volatile HttpURLConnection conn;
        private volatile boolean cancelled;

        public void cancel() {
            cancelled = true;
            HttpURLConnection c = conn;
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Exception ignored) {
                    // 取消本身就是尽力而为
                }
            }
        }

        public boolean isCancelled() {
            return cancelled;
        }

        private void attach(HttpURLConnection c) {
            conn = c;
            if (cancelled) c.disconnect();
        }
    }

    private static final ApiClient INSTANCE = new ApiClient();

    public static ApiClient get() {
        return INSTANCE;
    }

    private final ExecutorService pool = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "eea-api");
        t.setDaemon(true);
        return t;
    });
    private final Handler main = new Handler(Looper.getMainLooper());

    public <T> Request get(String path, Parser<T> parser, Callback<T> cb) {
        return call("GET", path, null, TIMEOUT_QUICK, parser, cb);
    }

    public <T> Request post(String path, JSONObject body, int readTimeoutMs, Parser<T> parser, Callback<T> cb) {
        return call("POST", path, body, readTimeoutMs, parser, cb);
    }

    /**
     * 消费 NDJSON 流式接口：逐行读取并解析事件，边读边回调（生成进度靠它显示真实步骤）。
     * 未激活时服务端在写响应头之前就拒绝，这里会走 onFailure（HTTP 403 信封）。
     */
    public Request stream(String path, JSONObject body, StreamCallback cb) {
        Request req = new Request();
        pool.execute(() -> {
            ApiError err = null;
            boolean finished = false;
            HttpURLConnection conn = null;
            try {
                conn = openConnection(path, "POST", body, TIMEOUT_GENERATE);
                req.attach(conn);
                int status = conn.getResponseCode();
                if (status >= 400) {
                    String text = readAll(conn.getErrorStream());
                    throw decodeError(status, text);
                }
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        if (req.isCancelled()) return;
                        String trimmed = line.trim();
                        if (trimmed.isEmpty()) continue;
                        JSONObject event;
                        try {
                            event = new JSONObject(trimmed);
                        } catch (Exception parse) {
                            continue; // 半行/心跳等非 JSON 内容直接跳过
                        }
                        final JSONObject payload = event;
                        main.post(() -> {
                            if (!req.isCancelled()) cb.onEvent(payload);
                        });
                    }
                }
                finished = true;
            } catch (ApiError e) {
                err = e;
            } catch (Exception e) {
                err = new ApiError(0, null, readable(e));
            } finally {
                disconnect(conn);
            }
            if (req.isCancelled()) return;
            final ApiError failure = err;
            final boolean ended = finished;
            main.post(() -> {
                if (req.isCancelled()) return;
                if (failure != null) cb.onFailure(failure);
                else if (ended) cb.onFinished();
            });
        });
        return req;
    }

    /** 二进制响应（/api/handwrite/pdf、/api/print/*）：直接拿 bytes，不做 JSON 解析。 */
    public Request bytes(String path, JSONObject body, int readTimeoutMs, Callback<byte[]> cb) {
        Request req = new Request();
        pool.execute(() -> {
            byte[] out = null;
            ApiError err = null;
            HttpURLConnection conn = null;
            try {
                conn = openConnection(path, "POST", body, readTimeoutMs);
                req.attach(conn);
                int status = conn.getResponseCode();
                byte[] raw = readBytes(status >= 400 ? conn.getErrorStream() : conn.getInputStream());
                if (status >= 400) {
                    throw decodeError(status, raw == null ? null : new String(raw, StandardCharsets.UTF_8));
                }
                if (raw == null || raw.length == 0) {
                    throw new ApiError(status, null, "本地服务返回了空内容（HTTP " + status + "）");
                }
                out = raw;
            } catch (ApiError e) {
                err = e;
            } catch (Exception e) {
                err = new ApiError(0, null, readable(e));
            } finally {
                disconnect(conn);
            }
            if (req.isCancelled()) return;
            final byte[] result = out;
            final ApiError failure = err;
            main.post(() -> {
                if (req.isCancelled()) return;
                if (failure == null) cb.onSuccess(result);
                else cb.onFailure(failure);
            });
        });
        return req;
    }

    /** 二进制 GET（真题图片等静态资源）：原样返回 bytes，交给 BitmapFactory 解码。 */
    public Request getBytes(String path, int readTimeoutMs, Callback<byte[]> cb) {
        Request req = new Request();
        pool.execute(() -> {
            byte[] out = null;
            ApiError err = null;
            HttpURLConnection conn = null;
            try {
                conn = openConnection(path, "GET", null, readTimeoutMs);
                req.attach(conn);
                int status = conn.getResponseCode();
                byte[] raw = readBytes(status >= 400 ? conn.getErrorStream() : conn.getInputStream());
                if (status >= 400) {
                    throw decodeError(status, raw == null ? null : new String(raw, StandardCharsets.UTF_8));
                }
                if (raw == null || raw.length == 0) {
                    throw new ApiError(status, null, "本地服务返回了空内容（HTTP " + status + "）");
                }
                out = raw;
            } catch (ApiError e) {
                err = e;
            } catch (Exception e) {
                err = new ApiError(0, null, readable(e));
            } finally {
                disconnect(conn);
            }
            if (req.isCancelled()) return;
            final byte[] result = out;
            final ApiError failure = err;
            main.post(() -> {
                if (req.isCancelled()) return;
                if (failure == null) cb.onSuccess(result);
                else cb.onFailure(failure);
            });
        });
        return req;
    }

    private <T> Request call(String method, String path, JSONObject body, int readTimeoutMs,
                             Parser<T> parser, Callback<T> cb) {        Request req = new Request();
        pool.execute(() -> {
            T out = null;
            ApiError err = null;
            HttpURLConnection conn = null;
            try {
                conn = openConnection(path, method, body, readTimeoutMs);
                req.attach(conn);
                int status = conn.getResponseCode();
                String text = readAll(status >= 400 ? conn.getErrorStream() : conn.getInputStream());
                if (text == null || text.trim().isEmpty()) {
                    throw new ApiError(status, null, "本地服务无响应（HTTP " + status + "）");
                }
                JSONObject obj = new JSONObject(text);
                if (!obj.optBoolean("ok", false)) {
                    throw new ApiError(status, obj.isNull("code") ? null : obj.optString("code"),
                            obj.optString("error", "接口返回失败"));
                }
                JSONObject data = obj.optJSONObject("data");
                out = parser.parse(data == null ? new JSONObject() : data);
            } catch (ApiError e) {
                err = e;
            } catch (Exception e) {
                err = new ApiError(0, null, readable(e));
            } finally {
                disconnect(conn);
            }
            if (req.isCancelled()) return;
            final T result = out;
            final ApiError failure = err;
            main.post(() -> {
                if (req.isCancelled()) return;
                if (failure == null) cb.onSuccess(result);
                else cb.onFailure(failure);
            });
        });
        return req;
    }

    private static HttpURLConnection openConnection(String path, String method, JSONObject body,
                                                    int readTimeoutMs) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(BASE_URL + path).openConnection();
        conn.setConnectTimeout(4000);
        conn.setReadTimeout(readTimeoutMs);
        conn.setRequestMethod(method);
        conn.setRequestProperty("Accept", "application/json");
        if (body != null) {
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(payload.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload);
            }
        }
        return conn;
    }

    private static ApiError decodeError(int status, String text) {
        if (text != null && !text.trim().isEmpty()) {
            try {
                JSONObject obj = new JSONObject(text);
                return new ApiError(status, obj.isNull("code") ? null : obj.optString("code"),
                        obj.optString("error", "接口返回失败"));
            } catch (Exception ignored) {
                // 非 JSON 错误体：退回通用文案
            }
        }
        return new ApiError(status, null, "本地服务返回 HTTP " + status);
    }

    private static void disconnect(HttpURLConnection conn) {
        if (conn != null) {
            try {
                conn.disconnect();
            } catch (Exception ignored) {
                // 关闭失败不影响结果
            }
        }
    }

    private static String readable(Exception e) {
        String msg = e.getMessage();
        if (msg == null || msg.isEmpty()) msg = e.toString();
        return msg;
    }

    private static String readAll(InputStream in) throws Exception {
        byte[] raw = readBytes(in);
        return raw == null ? null : new String(raw, StandardCharsets.UTF_8);
    }

    private static byte[] readBytes(InputStream in) throws Exception {
        if (in == null) return null;
        try (InputStream stream = in) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[16384];
            int n;
            while ((n = stream.read(chunk)) > 0) buf.write(chunk, 0, n);
            return buf.toByteArray();
        }
    }
}
