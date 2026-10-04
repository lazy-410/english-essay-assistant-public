package cn.kaoyan.essay.ui;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;

import org.json.JSONObject;

import java.util.List;

import cn.kaoyan.essay.MainActivity;
import cn.kaoyan.essay.R;
import cn.kaoyan.essay.core.AppState;
import cn.kaoyan.essay.core.ComposeStore;
import cn.kaoyan.essay.databinding.FragmentWriteBinding;
import cn.kaoyan.essay.net.ApiClient;
import cn.kaoyan.essay.net.ApiError;
import cn.kaoyan.essay.net.Dto;
import cn.kaoyan.essay.net.EeaApi;
import cn.kaoyan.essay.util.Images;

/**
 * 写作页：题干（拍照 / 相册 / 贴图 / 题库）→ 识图 → 流式成文。
 * 生成完成后把结果放进 ComposeStore，并压入结果页子页。
 */
public class WriteFragment extends Fragment {

    private FragmentWriteBinding b;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final StringBuilder log = new StringBuilder();
    private ApiClient.Request analyzeReq;
    private ApiClient.Request composeReq;
    private int rounds;
    private long startedAt;

    private final ActivityResultLauncher<Uri> takePicture = registerForActivityResult(
            new ActivityResultContracts.TakePicture(),
            ok -> {
                Context ctx = getContext();
                if (Boolean.TRUE.equals(ok) && ctx != null) analyzeImage(Images.cameraUri(ctx));
            });

    private final ActivityResultLauncher<String> pickImage = registerForActivityResult(
            new ActivityResultContracts.GetContent(),
            uri -> {
                if (uri != null) analyzeImage(uri);
            });

    private final AppState.Listener appListener = this::refreshKeyBanner;

    public WriteFragment() {
        super(R.layout.fragment_write);
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        b = FragmentWriteBinding.inflate(inflater, container, false);
        return b.getRoot();
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);
        b.writeQuestion.setText(ComposeStore.question);
        b.writePhoto.setOnClickListener(v -> takePicture.launch(Images.cameraUri(requireContext())));
        b.writeGallery.setOnClickListener(v -> pickImage.launch("image/*"));
        b.writePaste.setOnClickListener(v -> pasteFromClipboard());
        b.writeBank.setOnClickListener(v -> {
            MainActivity activity = (MainActivity) getActivity();
            if (activity != null) activity.openTab(R.id.nav_exams);
        });
        b.writeGenerate.setOnClickListener(v -> generate());
        b.writeCancel.setOnClickListener(v -> cancelComposeByUser());
        b.writeLastCard.setOnClickListener(v -> {
            MainActivity activity = (MainActivity) getActivity();
            if (activity != null) activity.openComposeResult();
        });
        b.writeKeyBanner.setOnClickListener(v -> {
            MainActivity activity = (MainActivity) getActivity();
            if (activity != null) activity.openSettings();
        });
        refreshKeyBanner();
        refreshLastCard();
    }

    @Override
    public void onResume() {
        super.onResume();
        AppState.get().addListener(appListener);
        refreshKeyBanner();
        refreshLastCard();
        if (ComposeStore.autoGenerate) {
            ComposeStore.autoGenerate = false;
            b.writeQuestion.post(this::generate);
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        AppState.get().removeListener(appListener);
    }

    @Override
    public void onDestroyView() {
        super.onDestroyView();
        if (analyzeReq != null) analyzeReq.cancel();
        if (composeReq != null) composeReq.cancel();
        b = null;
    }

    // ---------- 状态回显 ----------

    private void refreshKeyBanner() {
        if (b == null || !isAdded()) return;
        Ui.show(b.writeKeyBanner, !AppState.get().hasApiKey());
    }

    private void refreshLastCard() {
        if (b == null) return;
        if (!ComposeStore.hasResult()) {
            Ui.show(b.writeLastCard, false);
            return;
        }
        String title = ComposeStore.last.essayTitle == null || ComposeStore.last.essayTitle.isEmpty()
                ? getString(R.string.tab_write)
                : ComposeStore.last.essayTitle;
        b.writeLastText.setText(getString(R.string.write_last_result, ComposeStore.last.words) + "\n" + title);
        Ui.show(b.writeLastCard, true);
    }

    // ---------- 识图 ----------

    private void analyzeImage(Uri uri) {
        final Context ctx = getContext();
        if (ctx == null) return;
        Ui.show(b.writeRecognizeCard, true);
        Ui.show(b.writePhotoPreview, false);
        b.writeRecognizeTitle.setText(R.string.write_analyzing);
        Ui.show(b.writeConflict, false);
        Ui.show(b.writeOcrText, false);
        // 原图 -> data URL 是纯 CPU 活，别占主线程。
        new Thread(() -> {
            try {
                String dataUrl = Images.toDataUrl(ctx, uri);
                Bitmap thumb = Images.thumbnail(ctx, uri, 800);
                main.post(() -> {
                    if (b == null || !isAdded()) return;
                    ComposeStore.pendingImage = dataUrl;
                    if (thumb != null) {
                        b.writePhotoPreview.setImageBitmap(thumb);
                        Ui.show(b.writePhotoPreview, true);
                    }
                    requestAnalysis(dataUrl);
                });
            } catch (Exception e) {
                main.post(() -> {
                    if (b == null || !isAdded()) return;
                    Ui.show(b.writeRecognizeCard, false);
                    Ui.toast(this, getString(R.string.write_image_failed, String.valueOf(e.getMessage())));
                });
            }
        }).start();
    }

    private void requestAnalysis(String dataUrl) {
        if (analyzeReq != null) analyzeReq.cancel();
        analyzeReq = EeaApi.analyzeImage(dataUrl, new ApiClient.Callback<Dto.ImageAnalysis>() {
            @Override
            public void onSuccess(Dto.ImageAnalysis data) {
                if (b == null) return;
                ComposeStore.analysis = data;
                applyAnalysis(data);
            }

            @Override
            public void onFailure(ApiError error) {
                if (b == null) return;
                Ui.show(b.writeRecognizeCard, false);
                Ui.toast(WriteFragment.this, getString(R.string.write_failed, error.getMessage()));
            }
        });
    }

    private void applyAnalysis(Dto.ImageAnalysis a) {
        Ui.show(b.writeRecognizeCard, true);
        String question = a.composedQuestion == null ? "" : a.composedQuestion.trim();
        if (question.isEmpty() && a.ocrText != null) question = a.ocrText.trim();
        if (question.isEmpty()) {
            b.writeRecognizeTitle.setText(R.string.write_recognize_none);
        } else {
            b.writeQuestion.setText(question);
            ComposeStore.question = question;
            b.writeRecognizeTitle.setText(getString(R.string.write_recognized, backendLabel(a)));
        }
        String ocr = a.ocrText == null ? "" : a.ocrText.trim();
        if (!ocr.isEmpty()) {
            b.writeOcrText.setText(ocr);
            Ui.show(b.writeOcrText, true);
        } else {
            Ui.show(b.writeOcrText, false);
        }
        // 离线 OCR / 画面理解失败：如实提示效果降级，而不是假装识别完整。
        if ("desktop-local-ocr".equals(a.fallback)) {
            b.writeConflict.setText(R.string.write_fallback_ocr);
            Ui.show(b.writeConflict, true);
        } else if (a.visionError != null && !a.visionError.isEmpty()) {
            b.writeConflict.setText(getString(R.string.write_fallback_vision, a.visionError));
            Ui.show(b.writeConflict, true);
        } else if (!a.conflicts.isEmpty()) {
            b.writeConflict.setText(getString(R.string.write_conflicts, join(a.conflicts)));
            Ui.show(b.writeConflict, true);
        } else {
            Ui.show(b.writeConflict, false);
        }
    }

    private String backendLabel(Dto.ImageAnalysis a) {
        if (a.visionModel != null && !a.visionModel.isEmpty()) return a.visionModel;
        return getString(R.string.write_recognized_ocr);
    }

    /** step 事件的 summary 可能是对象（各步骤字段不同），压成一行可读文本而不是 JSON。 */
    private static String formatSummary(JSONObject event) {
        Object raw = event.opt("summary");
        if (raw == null || raw == JSONObject.NULL) return "";
        if (raw instanceof String) return ((String) raw).trim();
        if (raw instanceof JSONObject) {
            JSONObject obj = (JSONObject) raw;
            StringBuilder sb = new StringBuilder();
            java.util.Iterator<String> keys = obj.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                Object value = obj.opt(key);
                if (value == null || value == JSONObject.NULL) continue;
                if (value instanceof JSONObject || value instanceof org.json.JSONArray) continue;
                if (sb.length() > 0) sb.append(" · ");
                sb.append(value);
            }
            return sb.toString();
        }
        return String.valueOf(raw);
    }

    // ---------- 剪贴板 ----------

    private void pasteFromClipboard() {
        Context ctx = getContext();
        if (ctx == null) return;
        try {
            ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = cm == null ? null : cm.getPrimaryClip();
            Uri uri = Images.firstImageUri(clip);
            if (uri != null) {
                analyzeImage(uri);
                return;
            }
            CharSequence text = clip != null && clip.getItemCount() > 0 ? clip.getItemAt(0).coerceToText(ctx) : null;
            String plain = text == null ? "" : text.toString().trim();
            if (plain.isEmpty()) {
                Ui.toast(this, R.string.write_clipboard_empty);
                return;
            }
            // 贴进来的多半是 OCR 出来的一手文本，先清洗再落到题干框。
            b.writeRecognizeTitle.setText(R.string.write_cleaning);
            Ui.show(b.writeRecognizeCard, true);
            EeaApi.cleanQuestion(plain, new ApiClient.Callback<Dto.Cleaned>() {
                @Override
                public void onSuccess(Dto.Cleaned data) {
                    if (b == null) return;
                    String cleaned = data.cleaned == null || data.cleaned.trim().isEmpty() ? plain : data.cleaned.trim();
                    b.writeQuestion.setText(cleaned);
                    ComposeStore.question = cleaned;
                    ComposeStore.analysis = null;
                    ComposeStore.pendingImage = null;
                    Ui.show(b.writeRecognizeCard, false);
                }

                @Override
                public void onFailure(ApiError error) {
                    if (b == null) return;
                    b.writeQuestion.setText(plain);
                    ComposeStore.question = plain;
                    Ui.show(b.writeRecognizeCard, false);
                    Ui.toast(WriteFragment.this, getString(R.string.write_clean_failed, error.getMessage()));
                }
            });
        } catch (Exception e) {
            Ui.toast(this, R.string.write_clipboard_empty);
        }
    }

    // ---------- 流式成文 ----------

    private void generate() {
        if (b == null) return;
        String question = b.writeQuestion.getText() == null ? "" : b.writeQuestion.getText().toString().trim();
        if (question.isEmpty()) {
            Ui.toast(this, R.string.write_need_question);
            return;
        }
        ComposeStore.question = question;

        JSONObject body = new JSONObject();
        try {
            body.put("text", question);
            // 题图与识图结果一并带上：服务端据此走图表事实提取，题干里的数据才站得住。
            if (ComposeStore.pendingImage != null) body.put("image", ComposeStore.pendingImage);
            if (ComposeStore.analysis != null) body.put("imageAnalysis", ComposeStore.analysis.raw);
            // 从题库带入的真题：题干、图表数据与范文由服务端按 id 取，避免两边理解不一致。
            if (ComposeStore.examId != null && !ComposeStore.examId.isEmpty()) {
                body.put("examId", ComposeStore.examId);
            }
        } catch (Exception ignored) {
            // JSONObject.put 不会抛
        }

        cancelCompose();
        rounds = 0;
        startedAt = System.currentTimeMillis();
        log.setLength(0);
        b.writeLog.setText("");
        b.writeStep.setText(R.string.write_generating);
        b.writeRound.setText("");
        Ui.show(b.writeProgressBox, true);
        b.writeGenerate.setEnabled(false);
        setStatus(R.string.write_generating);

        composeReq = EeaApi.composeStream(body, new ApiClient.StreamCallback() {
            private boolean closed;

            @Override
            public void onEvent(JSONObject event) {
                handleEvent(event, this);
            }

            @Override
            public void onFailure(ApiError error) {
                if (closed) return;
                closed = true;
                finishGenerating();
                if (error.isNotActivated()) {
                    Ui.toast(WriteFragment.this, R.string.app_not_activated);
                    return;
                }
                Ui.toast(WriteFragment.this, getString(R.string.write_failed, error.getMessage()));
            }

            @Override
            public void onFinished() {
                if (closed) return;
                closed = true;
                finishGenerating();
                Ui.toast(WriteFragment.this, R.string.write_interrupted);
            }
        });
    }

    private void handleEvent(JSONObject event, ApiClient.StreamCallback cb) {
        String type = event.optString("type", "");
        if (b == null) return;
        switch (type) {
            case "start":
                appendLog(getString(R.string.write_log_engine, event.optString("engine", "")));
                break;
            case "step": {
                String label = event.optString("label", "");
                String summary = formatSummary(event);
                b.writeStep.setText(getString(R.string.write_step, label));
                appendLog(summary.isEmpty() ? label : label + " · " + summary);
                break;
            }
            case "round": {
                rounds++;
                String label = event.optString("label", event.optString("name", ""));
                b.writeRound.setText(getString(R.string.write_round, rounds));
                appendLog("↻ " + label);
                break;
            }
            case "done": {
                finishGenerating();
                setStatus(0);
                JSONObject data = event.optJSONObject("data");
                Dto.Compose compose = data == null ? null : EeaApi.composeFromEvent(data);
                if (compose == null || compose.paragraphs.isEmpty()) {
                    Ui.toast(this, R.string.result_empty);
                    return;
                }
                ComposeStore.last = compose;
                ComposeStore.lastAt = System.currentTimeMillis();
                ComposeStore.lastMs = startedAt > 0 ? ComposeStore.lastAt - startedAt : 0;
                refreshLastCard();
                MainActivity activity = (MainActivity) getActivity();
                if (activity != null) activity.openComposeResult();
                break;
            }
            case "error": {
                finishGenerating();
                setStatus(0);
                String message = event.optString("error", "");
                if ("NOT_ACTIVATED".equals(event.optString("code", ""))) {
                    Ui.toast(this, R.string.app_not_activated);
                } else {
                    Ui.toast(this, getString(R.string.write_failed, message));
                }
                break;
            }
            default:
                break;
        }
    }

    private void cancelCompose() {
        if (composeReq != null) {
            composeReq.cancel();
            composeReq = null;
        }
    }

    private void cancelComposeByUser() {
        if (composeReq == null) return;
        cancelCompose();
        finishGenerating();
        Ui.toast(this, R.string.write_cancelled);
    }

    private void finishGenerating() {
        if (b == null) return;
        Ui.show(b.writeProgressBox, false);
        b.writeGenerate.setEnabled(true);
    }

    private void appendLog(String line) {
        if (b == null || line == null || line.isEmpty()) return;
        log.append(line).append('\n');
        b.writeLog.setText(log.toString());
    }

    private void setStatus(int resId) {
        MainActivity activity = (MainActivity) getActivity();
        if (activity != null) activity.onStatus(resId == 0 ? "" : getString(resId));
    }

    private static String join(List<String> values) {
        StringBuilder sb = new StringBuilder();
        for (String value : values) {
            if (value == null || value.isEmpty()) continue;
            if (sb.length() > 0) sb.append("；");
            sb.append(value);
        }
        return sb.toString();
    }
}
