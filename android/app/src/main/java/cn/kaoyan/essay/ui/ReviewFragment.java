package cn.kaoyan.essay.ui;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.Fragment;

import cn.kaoyan.essay.MainActivity;
import cn.kaoyan.essay.R;
import cn.kaoyan.essay.core.ReviewStore;
import cn.kaoyan.essay.databinding.FragmentReviewBinding;
import cn.kaoyan.essay.net.ApiClient;
import cn.kaoyan.essay.net.ApiError;
import cn.kaoyan.essay.net.Dto;
import cn.kaoyan.essay.net.EeaApi;
import cn.kaoyan.essay.util.Images;

/**
 * 批改第一步（上传手写作文）与第二步（校对文本、选真题、确认题型）。
 * 批改结果在 ReviewStore 里，第三步由 ReviewResultFragment 展示。
 */
public class ReviewFragment extends Fragment {

    /** 与题型判定服务同源的三个题型（服务端按中文取值分流）。 */
    private static final String[] CATEGORIES = {"图表作文", "大作文", "小作文"};
    private static final int MIN_WORDS_FOR_DETECT = 20;
    private static final long DETECT_DEBOUNCE_MS = 900L;

    private FragmentReviewBinding b;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private ApiClient.Request ocrReq;
    private ApiClient.Request analyzeReq;
    private ApiClient.Request classifyReq;
    private final Runnable detectTask = this::detectCategory;

    private final ActivityResultLauncher<Uri> takePicture = registerForActivityResult(
            new ActivityResultContracts.TakePicture(),
            ok -> {
                Context ctx = getContext();
                if (Boolean.TRUE.equals(ok) && ctx != null) runOcr(Images.cameraUri(ctx));
            });

    private final ActivityResultLauncher<String> pickImage = registerForActivityResult(
            new ActivityResultContracts.GetContent(),
            uri -> {
                if (uri != null) runOcr(uri);
            });

    public ReviewFragment() {
        super(R.layout.fragment_review);
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        b = FragmentReviewBinding.inflate(inflater, container, false);
        return b.getRoot();
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);
        b.rvCategory.setSimpleItems(CATEGORIES);
        bindText();
        restore();
        b.rvPhoto.setOnClickListener(v -> takePicture.launch(Images.cameraUri(requireContext())));
        b.rvGallery.setOnClickListener(v -> pickImage.launch("image/*"));
        b.rvPaste.setOnClickListener(v -> paste());
        b.rvManual.setOnClickListener(v -> {
            b.rvText.requestFocus();
            Ui.toast(this, R.string.rv_manual_hint);
        });
        b.rvRestoreRaw.setOnClickListener(v -> {
            b.rvText.setText(ReviewStore.rawText);
            b.rvText.setSelection(b.rvText.getText() == null ? 0 : b.rvText.getText().length());
        });
        b.rvPickExam.setOnClickListener(v -> new ExamPickerDialog().show(getParentFragmentManager(), "exam-pick"));
        b.rvClearExam.setOnClickListener(v -> {
            ReviewStore.useFree(b.rvCategory.getText() == null ? "" : b.rvCategory.getText().toString(), text(b.rvQuestion));
            renderExamMode();
        });
        b.rvAi.setChecked(ReviewStore.aiDeepen);
        b.rvAiGrammar.setChecked(ReviewStore.aiGrammar);
        b.rvAnalyze.setOnClickListener(v -> analyze());
        getParentFragmentManager().setFragmentResultListener(ExamPickerDialog.REQUEST_KEY, getViewLifecycleOwner(),
                (key, result) -> {
                    String id = result.getString(ExamPickerDialog.RESULT_ID);
                    String label = result.getString(ExamPickerDialog.RESULT_LABEL);
                    String question = result.getString(ExamPickerDialog.RESULT_QUESTION);
                    ReviewStore.examId = id;
                    ReviewStore.examLabel = label;
                    ReviewStore.questionText = question == null ? "" : question;
                    b.rvQuestion.setText(ReviewStore.questionText == null ? "" : ReviewStore.questionText);
                    renderExamMode();
                });
    }

    @Override
    public void onDestroyView() {
        super.onDestroyView();
        handler.removeCallbacks(detectTask);
        if (ocrReq != null) ocrReq.cancel();
        if (analyzeReq != null) analyzeReq.cancel();
        if (classifyReq != null) classifyReq.cancel();
        b = null;
    }

    // ---------- 回显 ----------

    private void bindText() {
        b.rvText.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
            }

            @Override
            public void afterTextChanged(Editable s) {
                String value = s == null ? "" : s.toString();
                ReviewStore.essayText = value;
                b.rvWordCount.setText(getString(R.string.rv_words, wordCount(value)));
                ReviewStore.resetResult();
                handler.removeCallbacks(detectTask);
                handler.postDelayed(detectTask, DETECT_DEBOUNCE_MS);
            }
        });
    }

    private void restore() {
        b.rvText.setText(ReviewStore.essayText);
        b.rvQuestion.setText(ReviewStore.questionText == null ? "" : ReviewStore.questionText);
        if (ReviewStore.category != null && !ReviewStore.category.isEmpty()) {
            b.rvCategory.setText(ReviewStore.category, false);
        }
        b.rvWordCount.setText(getString(R.string.rv_words, wordCount(ReviewStore.essayText)));
        if (ReviewStore.rawText != null && !ReviewStore.rawText.isEmpty()
                && !ReviewStore.rawText.equals(ReviewStore.essayText)) {
            Ui.show(b.rvRestoreRaw, true);
        }
        if (ReviewStore.ocrNote != null && !ReviewStore.ocrNote.isEmpty()) {
            b.rvNote.setText(ReviewStore.ocrNote);
            b.rvNote.setTextColor(ContextCompat.getColor(requireContext(),
                    ReviewStore.ocrLowQuality ? R.color.warning : R.color.text_secondary));
            Ui.show(b.rvNote, true);
        }
        renderExamMode();
    }

    private void renderExamMode() {
        boolean examMode = ReviewStore.isExamMode();
        b.rvExamLabel.setText(examMode
                ? getString(R.string.rv_exam_mode, ReviewStore.examLabel == null ? "" : ReviewStore.examLabel)
                : getString(R.string.rv_exam_none));
        Ui.show(b.rvClearExam, examMode);
        // 真题模式下题型与题干由题库决定，隐藏自由模式的两个输入。
        Ui.show(b.rvCategoryBox, !examMode);
        Ui.show(b.rvQuestionBox, !examMode);
    }

    // ---------- 照片与剪贴板 ----------

    private void runOcr(Uri uri) {
        final Context ctx = getContext();
        if (ctx == null) return;
        setBusy(true);
        note(getString(R.string.rv_ocr_running), R.color.text_secondary);
        new Thread(() -> {
            try {
                String dataUrl = Images.toDataUrl(ctx, uri);
                Bitmap thumb = Images.thumbnail(ctx, uri, 900);
                mainPost(() -> {
                    if (b == null) return;
                    if (thumb != null) {
                        b.rvPreview.setImageBitmap(thumb);
                        Ui.show(b.rvPreview, true);
                    }
                    ReviewStore.image = dataUrl;
                    requestOcr(dataUrl);
                });
            } catch (Exception e) {
                mainPost(() -> {
                    setBusy(false);
                    note(getString(R.string.rv_ocr_failed, String.valueOf(e.getMessage())), R.color.danger);
                });
            }
        }).start();
    }

    private void requestOcr(String dataUrl) {
        if (ocrReq != null) ocrReq.cancel();
        ocrReq = EeaApi.reviewOcr(dataUrl, new ApiClient.Callback<Dto.ReviewOcr>() {
            @Override
            public void onSuccess(Dto.ReviewOcr data) {
                if (b == null) return;
                setBusy(false);
                applyOcr(data);
            }

            @Override
            public void onFailure(ApiError error) {
                if (b == null) return;
                setBusy(false);
                note(getString(R.string.rv_ocr_failed, error.getMessage()), R.color.danger);
            }
        });
    }

    private void applyOcr(Dto.ReviewOcr data) {
        ReviewStore.rawText = data.raw == null ? "" : data.raw;
        String cleaned = data.cleaned == null || data.cleaned.trim().isEmpty() ? ReviewStore.rawText : data.cleaned;
        b.rvText.setText(cleaned);
        ReviewStore.ocrLowQuality = data.lowQuality;
        Ui.show(b.rvRestoreRaw, !ReviewStore.rawText.equals(cleaned));

        StringBuilder note = new StringBuilder();
        if (data.rotationDetected != 0) {
            note.append(getString(R.string.rv_rotate_note, Math.round(data.rotationDetected))).append('；');
        }
        if (data.unreadableCount > 0) note.append(data.unreadableCount).append(" 处无法辨认；");
        String channel = data.channelLabel == null || data.channelLabel.isEmpty() ? data.backend : data.channelLabel;
        if (data.lowQuality) {
            note.append(getString(R.string.rv_ocr_low_note));
            note(getString(R.string.rv_ocr_low, channel, Math.round(data.latinRatio * 100), note.toString()), R.color.danger);
        } else {
            note(getString(R.string.rv_ocr_ok, channel, note.toString()), R.color.text_secondary);
        }
        if ("local-ocr".equals(data.channel) && data.visionError != null && !data.visionError.isEmpty()) {
            b.rvNote.append("\n" + getString(R.string.rv_vision_note, data.visionError));
        }
        if (data.detection != null) applyDetection(data.detection);
    }

    private void paste() {
        Context ctx = getContext();
        if (ctx == null) return;
        try {
            ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = cm == null ? null : cm.getPrimaryClip();
            Uri uri = Images.firstImageUri(clip);
            if (uri != null) {
                runOcr(uri);
                return;
            }
            CharSequence text = clip != null && clip.getItemCount() > 0 ? clip.getItemAt(0).coerceToText(ctx) : null;
            String plain = text == null ? "" : text.toString().trim();
            if (plain.isEmpty()) {
                Ui.toast(this, R.string.write_clipboard_empty);
                return;
            }
            b.rvText.setText(plain);
            b.rvText.setSelection(b.rvText.getText() == null ? 0 : b.rvText.getText().length());
            Ui.toast(this, R.string.rv_clipboard_text);
        } catch (Exception e) {
            Ui.toast(this, R.string.write_clipboard_empty);
        }
    }

    // ---------- 题型判定 ----------

    private void detectCategory() {
        if (b == null) return;
        if (ReviewStore.isExamMode()) return;
        String essayText = text(b.rvText);
        if (wordCount(essayText) < MIN_WORDS_FOR_DETECT) return;
        if (classifyReq != null) classifyReq.cancel();
        classifyReq = EeaApi.reviewClassify(essayText, text(b.rvQuestion), new ApiClient.Callback<Dto.Detection>() {
            @Override
            public void onSuccess(Dto.Detection data) {
                if (b == null || data == null) return;
                applyDetection(data);
            }

            @Override
            public void onFailure(ApiError error) {
                // 判定失败不打扰用户，题型仍可手选
            }
        });
    }

    private void applyDetection(Dto.Detection detection) {
        if (b == null || detection == null || detection.category == null || detection.category.isEmpty()) return;
        if (!ReviewStore.isExamMode()) {
            b.rvCategory.setText(detection.category, false);
            ReviewStore.category = detection.category;
        }
        StringBuilder evidence = new StringBuilder();
        for (String line : detection.evidence) {
            if (evidence.length() > 0) evidence.append('；');
            evidence.append(line);
        }
        b.rvDetection.setText(getString(R.string.rv_detected, detection.category,
                detection.confident ? "" : getString(R.string.rv_detected_unsure), evidence.toString()));
    }

    // ---------- 批改 ----------

    private void analyze() {
        String essayText = text(b.rvText);
        if (essayText.isEmpty()) {
            Ui.toast(this, R.string.rv_need_text);
            return;
        }
        ReviewStore.essayText = essayText;
        if (!ReviewStore.isExamMode()) {
            ReviewStore.category = b.rvCategory.getText() == null ? "" : b.rvCategory.getText().toString();
            ReviewStore.questionText = text(b.rvQuestion);
        }
        ReviewStore.aiDeepen = b.rvAi.isChecked();
        ReviewStore.aiGrammar = b.rvAiGrammar.isChecked();
        setBusy(true);
        if (analyzeReq != null) analyzeReq.cancel();
        analyzeReq = EeaApi.reviewAnalyze(ReviewStore.analyzeBody(), new ApiClient.Callback<Dto.Review>() {
            @Override
            public void onSuccess(Dto.Review data) {
                if (b == null) return;
                setBusy(false);
                ReviewStore.review = data;
                ReviewStore.accepted.clear();
                ReviewStore.finalText = ReviewStore.essayText;
                ReviewStore.applied = null;
                MainActivity activity = (MainActivity) getActivity();
                if (activity != null) activity.openReviewResult();
            }

            @Override
            public void onFailure(ApiError error) {
                if (b == null) return;
                setBusy(false);
                Ui.toast(ReviewFragment.this, getString(R.string.rv_failed, error.getMessage()));
            }
        });
    }

    // ---------- 小工具 ----------

    private void setBusy(boolean busy) {
        if (b == null) return;
        b.rvAnalyze.setEnabled(!busy);
        Ui.show(b.rvProgress, busy);
        Ui.show(b.rvBusy, busy);
    }

    private void note(String message, int colorRes) {
        if (b == null) return;
        b.rvNote.setText(message);
        b.rvNote.setTextColor(ContextCompat.getColor(requireContext(), colorRes));
        Ui.show(b.rvNote, true);
    }

    private void mainPost(Runnable task) {
        handler.post(() -> {
            if (b == null || !isAdded()) return;
            task.run();
        });
    }

    private static String text(com.google.android.material.textfield.TextInputEditText view) {
        if (view == null || view.getText() == null) return "";
        return view.getText().toString().trim();
    }

    private static int wordCount(String value) {
        if (value == null || value.trim().isEmpty()) return 0;
        return value.trim().split("\\s+").length;
    }
}
