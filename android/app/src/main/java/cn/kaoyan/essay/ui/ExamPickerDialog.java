package cn.kaoyan.essay.ui;

import android.app.Dialog;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.DialogFragment;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

import cn.kaoyan.essay.R;
import cn.kaoyan.essay.core.AppState;
import cn.kaoyan.essay.databinding.DialogExamPickBinding;
import cn.kaoyan.essay.databinding.ItemExamBinding;
import cn.kaoyan.essay.net.ApiClient;
import cn.kaoyan.essay.net.ApiError;
import cn.kaoyan.essay.net.Dto;
import cn.kaoyan.essay.net.EeaApi;

/**
 * 真题选择：科目 / 年份 / 大小作文 / 类型 四级联动筛出列表，点选后把题目回传给调用方。
 * 批改页与题库页共用（题库页在 B4 复用同一套筛选逻辑）。
 */
public class ExamPickerDialog extends DialogFragment {

    public static final String REQUEST_KEY = "eea-exam-pick";
    public static final String RESULT_ID = "examId";
    public static final String RESULT_LABEL = "examLabel";
    public static final String RESULT_QUESTION = "examQuestion";

    private static final String ALL = "全部";

    private DialogExamPickBinding b;
    private ApiClient.Request req;
    private Adapter adapter;
    private final List<Dto.ExamBrief> all = new ArrayList<>();
    private final List<Dto.ExamBrief> shown = new ArrayList<>();
    private String subject = "";
    private String year = "";
    private String section = "";
    private String essayType = "";

    public ExamPickerDialog() {
        super();
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        b = DialogExamPickBinding.inflate(inflater, container, false);
        return b.getRoot();
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);
        adapter = new Adapter();
        b.pickList.setLayoutManager(new LinearLayoutManager(requireContext()));
        b.pickList.setAdapter(adapter);
        b.pickCancel.setOnClickListener(v -> dismiss());
        Dto.ExamType examType = AppState.get().examType();
        if (examType != null && examType.examType != null) subject = examType.examType;
        bindDropdown(b.pickSubject, subjectLabels(), () -> subject, value -> {
            subject = value;
            load();
        });
        bindDropdown(b.pickYear, new String[]{ALL}, () -> ALL, value -> {
            year = ALL.equals(value) ? "" : value;
            applyFilters();
        });
        bindDropdown(b.pickSection, new String[]{ALL}, () -> ALL, value -> {
            section = ALL.equals(value) ? "" : value;
            applyFilters();
        });
        bindDropdown(b.pickType, new String[]{ALL}, () -> ALL, value -> {
            essayType = ALL.equals(value) ? "" : value;
            applyFilters();
        });
        load();
    }

    @Override
    public void onStart() {
        super.onStart();
        Dialog dialog = getDialog();
        if (dialog == null) return;
        Window window = dialog.getWindow();
        if (window == null) return;
        WindowManager.LayoutParams lp = window.getAttributes();
        lp.width = (int) (getResources().getDisplayMetrics().widthPixels * 0.94f);
        window.setAttributes(lp);
    }

    @Override
    public void onDestroyView() {
        super.onDestroyView();
        if (req != null) req.cancel();
        b = null;
    }

    // ---------- 数据 ----------

    private void load() {
        if (b == null) return;
        b.pickLoading.setVisibility(View.VISIBLE);
        b.pickEmpty.setVisibility(View.GONE);
        final String filter = subject == null || subject.isEmpty() ? "" : "examType=" + subject;
        req = EeaApi.exams(filter, new ApiClient.Callback<Dto.ExamPage>() {
            @Override
            public void onSuccess(Dto.ExamPage data) {
                if (b == null) return;
                b.pickLoading.setVisibility(View.GONE);
                all.clear();
                all.addAll(data.items);
                year = "";
                section = "";
                essayType = "";
                bindDropdown(b.pickYear, yearLabels(), () -> ALL, value -> {
                    year = ALL.equals(value) ? "" : value;
                    applyFilters();
                });
                bindDropdown(b.pickSection, sectionLabels(), () -> ALL, value -> {
                    section = ALL.equals(value) ? "" : value;
                    applyFilters();
                });
                bindDropdown(b.pickType, typeLabels(), () -> ALL, value -> {
                    essayType = ALL.equals(value) ? "" : value;
                    applyFilters();
                });
                applyFilters();
            }

            @Override
            public void onFailure(ApiError error) {
                if (b == null) return;
                b.pickLoading.setVisibility(View.GONE);
                b.pickEmpty.setText(getString(R.string.rv_pick_failed, error.getMessage()));
                b.pickEmpty.setVisibility(View.VISIBLE);
            }
        });
    }

    private void applyFilters() {
        shown.clear();
        for (Dto.ExamBrief exam : all) {
            if (!subject.isEmpty() && !subject.equals(exam.examType)) continue;
            if (!year.isEmpty() && !year.equals(exam.year)) continue;
            if (!section.isEmpty() && !section.equals(exam.section)) continue;
            if (!essayType.isEmpty() && !essayType.equals(exam.essayType)) continue;
            shown.add(exam);
        }
        if (adapter != null) adapter.notifyDataSetChanged();
        if (b == null) return;
        boolean empty = shown.isEmpty();
        b.pickEmpty.setVisibility(empty && all.isEmpty() ? View.VISIBLE : View.GONE);
        b.pickCount.setText(getString(R.string.rv_pick_count, shown.size()));
        b.pickList.setVisibility(empty ? View.GONE : View.VISIBLE);
    }

    private String[] subjectLabels() {
        List<String> labels = new ArrayList<>();
        labels.add(ALL);
        labels.add("英语一");
        labels.add("英语二");
        return labels.toArray(new String[0]);
    }

    private String[] yearLabels() {
        LinkedHashSet<String> years = new LinkedHashSet<>();
        for (Dto.ExamBrief exam : all) {
            if (exam.year != null && !exam.year.isEmpty()) years.add(exam.year);
        }
        List<String> sorted = new ArrayList<>(years);
        java.util.Collections.sort(sorted, java.util.Collections.reverseOrder());
        List<String> labels = new ArrayList<>();
        labels.add(ALL);
        labels.addAll(sorted);
        return labels.toArray(new String[0]);
    }

    private String[] sectionLabels() {
        boolean hasSmall = false;
        boolean hasLarge = false;
        for (Dto.ExamBrief exam : all) {
            if ("small".equals(exam.section)) hasSmall = true;
            else hasLarge = true;
        }
        List<String> labels = new ArrayList<>();
        labels.add(ALL);
        if (hasLarge || !hasSmall) labels.add("大作文");
        if (hasSmall) labels.add("小作文");
        return labels.toArray(new String[0]);
    }

    private String[] typeLabels() {
        Map<String, String> types = new LinkedHashMap<>();
        for (Dto.ExamBrief exam : all) {
            if (exam.essayType == null || exam.essayType.isEmpty()) continue;
            types.put(exam.essayType, exam.typeLabel());
        }
        List<String> labels = new ArrayList<>();
        labels.add(ALL);
        labels.addAll(types.values());
        return labels.toArray(new String[0]);
    }

    /** 下拉绑定：显示中文标签，内部再映射回原始取值。 */
    private interface ValueGetter {
        String get();
    }

    private interface ValueSetter {
        void set(String value);
    }

    private void bindDropdown(com.google.android.material.textfield.MaterialAutoCompleteTextView view,
                              String[] labels, ValueGetter getter, ValueSetter setter) {
        if (view == null) return;
        view.setSimpleItems(labels);
        String current = getter.get();
        view.setText(labelFor(labels, current), false);
        view.setOnItemClickListener((parent, v, position, id) -> setter.set(valueFor(labels, labels[position])));
    }

    private String labelFor(String[] labels, String raw) {
        if (raw == null || raw.isEmpty()) return ALL;
        for (String label : labels) {
            if (raw.equals(valueFor(labels, label))) return label;
        }
        return ALL;
    }

    /** 把显示标签映射成过筛子用的原始取值。 */
    private String valueFor(String[] labels, String label) {
        if (label == null || ALL.equals(label)) return "";
        if ("英语一".equals(label)) return "e1";
        if ("英语二".equals(label)) return "e2";
        if ("大作文".equals(label)) return "large";
        if ("小作文".equals(label)) return "small";
        // 年份直接是原值；题型标签需要反查
        for (Dto.ExamBrief exam : all) {
            if (label.equals(exam.typeLabel())) return exam.essayType;
        }
        return label;
    }

    // ---------- 列表 ----------

    private final class Adapter extends RecyclerView.Adapter<Adapter.Holder> {

        final class Holder extends RecyclerView.ViewHolder {
            final ItemExamBinding row;

            Holder(ItemExamBinding row) {
                super(row.getRoot());
                this.row = row;
            }
        }

        @NonNull
        @Override
        public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
            return new Holder(ItemExamBinding.inflate(getLayoutInflater(), parent, false));
        }

        @Override
        public void onBindViewHolder(@NonNull Holder holder, int position) {
            final Dto.ExamBrief exam = shown.get(position);
            holder.row.examTitle.setText(exam.listTitle());
            holder.row.examSubtitle.setText(exam.listSubtitle());
            holder.row.examEssayTag.setText(exam.hasEssay ? getString(R.string.rv_pick_has_essay) : "");
            holder.row.examEssayTag.setVisibility(exam.hasEssay ? View.VISIBLE : View.GONE);
            holder.row.getRoot().setOnClickListener(v -> {
                Bundle result = new Bundle();
                result.putString(RESULT_ID, exam.id);
                result.putString(RESULT_LABEL, exam.listTitle());
                String question = exam.prompt != null && !exam.prompt.isEmpty() ? exam.prompt : exam.directions;
                result.putString(RESULT_QUESTION, question);
                getParentFragmentManager().setFragmentResult(REQUEST_KEY, result);
                dismiss();
            });
        }

        @Override
        public int getItemCount() {
            return shown.size();
        }
    }
}
