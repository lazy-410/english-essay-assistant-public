package cn.kaoyan.essay.ui;

import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import cn.kaoyan.essay.MainActivity;
import cn.kaoyan.essay.R;
import cn.kaoyan.essay.core.AppState;
import cn.kaoyan.essay.databinding.FragmentExamsBinding;
import cn.kaoyan.essay.databinding.ItemExamBinding;
import cn.kaoyan.essay.net.ApiClient;
import cn.kaoyan.essay.net.ApiError;
import cn.kaoyan.essay.net.Dto;
import cn.kaoyan.essay.net.EeaApi;

/**
 * 题库页：统计 + 科目/年份/卷别/类型/关键词筛选 → 列表 → 详情子页。
 * 筛选项的取值来自 /api/exams/stats（与桌面端同源，避免硬编码年份）。
 */
public class ExamsFragment extends Fragment {

    private static final String ALL = "全部";
    private static final int LIST_LIMIT = 200;

    private FragmentExamsBinding b;
    private ApiClient.Request statsReq;
    private ApiClient.Request listReq;
    private Adapter adapter;
    private final List<Dto.ExamBrief> items = new ArrayList<>();

    private String[] subjectLabels = {ALL};
    private String[] yearLabels = {ALL};
    private String[] sectionLabels = {ALL};
    private String[] typeLabels = {ALL};
    private String subject = "";
    private String year = "";
    private String section = "";
    private String essayType = "";

    public ExamsFragment() {
        super(R.layout.fragment_exams);
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        b = FragmentExamsBinding.inflate(inflater, container, false);
        return b.getRoot();
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);
        adapter = new Adapter();
        b.exList.setLayoutManager(new LinearLayoutManager(requireContext()));
        b.exList.setAdapter(adapter);
        Dto.ExamType examType = AppState.get().examType();
        if (examType != null && examType.examType != null) subject = examType.examType;

        bindDropdown(b.exSubject, () -> labelForSubject(subject), value -> {
            subject = value;
            search();
        });
        bindDropdown(b.exYear, () -> labelFor(yearLabels, year), value -> {
            year = ALL.equals(value) ? "" : value;
            search();
        });
        bindDropdown(b.exSection, () -> labelFor(sectionLabels, section), value -> {
            section = ALL.equals(value) ? "" : value;
            search();
        });
        bindDropdown(b.exType, () -> labelFor(typeLabels, essayType), value -> {
            essayType = ALL.equals(value) ? "" : value;
            search();
        });
        b.exSearch.setOnClickListener(v -> search());
        b.exKeyword.setOnEditorActionListener((v, actionId, event) -> {
            search();
            return true;
        });
        b.exReset.setOnClickListener(v -> {
            subject = "";
            year = "";
            section = "";
            essayType = "";
            b.exKeyword.setText("");
            b.exHasEssay.setChecked(false);
            bindDropdown(b.exSubject, () -> ALL, value -> {
                subject = value;
                search();
            });
            bindDropdown(b.exYear, () -> ALL, value -> {
                year = ALL.equals(value) ? "" : value;
                search();
            });
            bindDropdown(b.exSection, () -> ALL, value -> {
                section = ALL.equals(value) ? "" : value;
                search();
            });
            bindDropdown(b.exType, () -> ALL, value -> {
                essayType = ALL.equals(value) ? "" : value;
                search();
            });
            search();
        });
        loadStats();
        search();
    }

    @Override
    public void onDestroyView() {
        super.onDestroyView();
        if (statsReq != null) statsReq.cancel();
        if (listReq != null) listReq.cancel();
        b = null;
    }

    // ---------- 统计 ----------

    private void loadStats() {
        if (statsReq != null) statsReq.cancel();
        statsReq = EeaApi.examStats(new ApiClient.Callback<Dto.ExamStats>() {
            @Override
            public void onSuccess(Dto.ExamStats data) {
                if (b == null) return;
                subjectLabels = labelsOf(data.examTypes, SUBJECT_LABELS);
                yearLabels = sortedYears(data.years);
                sectionLabels = labelsOf(data.sections, SECTION_LABELS);
                typeLabels = labelsOf(data.essayTypes, ESSAY_TYPE_LABELS);
                bindDropdown(b.exSubject, () -> labelForSubject(subject), value -> {
                    subject = value;
                    search();
                });
                bindDropdown(b.exYear, () -> labelFor(yearLabels, year), value -> {
                    year = ALL.equals(value) ? "" : value;
                    search();
                });
                bindDropdown(b.exSection, () -> labelFor(sectionLabels, section), value -> {
                    section = ALL.equals(value) ? "" : value;
                    search();
                });
                bindDropdown(b.exType, () -> labelFor(typeLabels, essayType), value -> {
                    essayType = ALL.equals(value) ? "" : value;
                    search();
                });
                renderStats(data);
            }

            @Override
            public void onFailure(ApiError error) {
                // 统计失败不阻塞列表检索
            }
        });
    }

    private void renderStats(Dto.ExamStats stats) {
        b.exStats.removeAllViews();
        int chart = value(stats.essayTypes, "chart") + value(stats.essayTypes, "hybrid");
        addStatRow(new String[][]{
                {String.valueOf(stats.exams), getString(R.string.ex_stat_total)},
                {String.valueOf(stats.withEssay), getString(R.string.ex_stat_essay)},
                {String.valueOf(value(stats.examTypes, "e1")), getString(R.string.ex_stat_e1)},
        });
        addStatRow(new String[][]{
                {String.valueOf(value(stats.examTypes, "e2")), getString(R.string.ex_stat_e2)},
                {String.valueOf(value(stats.essayTypes, "picture")), getString(R.string.ex_stat_picture)},
                {String.valueOf(chart), getString(R.string.ex_stat_chart)},
        });
    }

    private void addStatRow(String[][] cells) {
        LinearLayoutRow row = new LinearLayoutRow(requireContext());
        for (String[] cell : cells) row.add(cell[0], cell[1]);
        b.exStats.addView(row.view);
    }

    /** 统计行：三格等宽（值在上、标签在下）。 */
    private final class LinearLayoutRow {
        final android.widget.LinearLayout view;

        LinearLayoutRow(android.content.Context ctx) {
            view = new android.widget.LinearLayout(ctx);
            view.setOrientation(android.widget.LinearLayout.HORIZONTAL);
        }

        void add(String value, String label) {
            android.widget.LinearLayout column = new android.widget.LinearLayout(view.getContext());
            column.setOrientation(android.widget.LinearLayout.VERTICAL);
            android.widget.TextView valueView = new android.widget.TextView(view.getContext());
            valueView.setText(value);
            valueView.setTextColor(androidx.core.content.ContextCompat.getColor(view.getContext(), R.color.text_primary));
            valueView.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX,
                    getResources().getDimension(R.dimen.text_title));
            android.widget.TextView labelView = new android.widget.TextView(view.getContext());
            labelView.setText(label);
            labelView.setTextColor(androidx.core.content.ContextCompat.getColor(view.getContext(), R.color.text_secondary));
            labelView.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX,
                    getResources().getDimension(R.dimen.text_caption));
            column.addView(valueView);
            column.addView(labelView);
            android.widget.LinearLayout.LayoutParams lp = new android.widget.LinearLayout.LayoutParams(
                    0, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            view.addView(column, lp);
        }
    }

    // ---------- 列表 ----------

    private void search() {
        if (b == null) return;
        setLoading(true);
        String query = buildQuery();
        if (listReq != null) listReq.cancel();
        listReq = EeaApi.exams(query, new ApiClient.Callback<Dto.ExamPage>() {
            @Override
            public void onSuccess(Dto.ExamPage data) {
                if (b == null) return;
                setLoading(false);
                items.clear();
                items.addAll(data.items);
                adapter.notifyDataSetChanged();
                b.exCount.setText(getString(R.string.rv_pick_count, items.size()));
                Ui.show(b.exEmpty, items.isEmpty());
            }

            @Override
            public void onFailure(ApiError error) {
                if (b == null) return;
                setLoading(false);
                b.exCount.setText(getString(R.string.ex_failed, error.getMessage()));
                Ui.show(b.exEmpty, items.isEmpty());
            }
        });
    }

    private String buildQuery() {
        StringBuilder sb = new StringBuilder();
        append(sb, "examType", subject);
        append(sb, "year", year);
        append(sb, "section", section);
        append(sb, "essayType", essayType);
        String keyword = b.exKeyword.getText() == null ? "" : b.exKeyword.getText().toString().trim();
        if (!keyword.isEmpty()) append(sb, "keyword", keyword);
        if (b.exHasEssay.isChecked()) append(sb, "hasEssay", "true");
        append(sb, "limit", String.valueOf(LIST_LIMIT));
        return sb.toString();
    }

    private void append(StringBuilder sb, String key, String value) {
        if (value == null || value.isEmpty()) return;
        if (sb.length() > 0) sb.append('&');
        sb.append(key).append('=').append(android.net.Uri.encode(value));
    }

    private void setLoading(boolean loading) {
        if (b == null) return;
        Ui.show(b.exLoading, loading);
        b.exSearch.setEnabled(!loading);
    }

    // ---------- 下拉 ----------

    private interface ValueGetter {
        String get();
    }

    private interface ValueSetter {
        void set(String value);
    }

    private void bindDropdown(com.google.android.material.textfield.MaterialAutoCompleteTextView view,
                              ValueGetter getter, ValueSetter setter) {
        if (view == null) return;
        String[] labels = labelsFor(view);
        view.setSimpleItems(labels);
        view.setText(getter.get(), false);
        view.setOnItemClickListener((parent, v, position, id) -> setter.set(valueFor(labels[position])));
    }

    private String[] labelsFor(com.google.android.material.textfield.MaterialAutoCompleteTextView view) {
        if (view.getId() == R.id.ex_subject) return subjectLabels;
        if (view.getId() == R.id.ex_year) return yearLabels;
        if (view.getId() == R.id.ex_section) return sectionLabels;
        return typeLabels;
    }

    private String labelForSubject(String raw) {
        if (raw == null || raw.isEmpty()) return ALL;
        return labelOf(subjectLabels, raw, SUBJECT_LABELS);
    }

    private static final Map<String, String> SUBJECT_LABELS = new LinkedHashMap<>();
    private static final Map<String, String> SECTION_LABELS = new LinkedHashMap<>();
    private static final Map<String, String> ESSAY_TYPE_LABELS = new LinkedHashMap<>();

    static {
        SUBJECT_LABELS.put("e1", "英语一");
        SUBJECT_LABELS.put("e2", "英语二");
        SECTION_LABELS.put("big", "大作文");
        SECTION_LABELS.put("small", "小作文");
        ESSAY_TYPE_LABELS.put("picture", "图画作文");
        ESSAY_TYPE_LABELS.put("chart", "图表作文");
        ESSAY_TYPE_LABELS.put("hybrid", "图画+图表");
        ESSAY_TYPE_LABELS.put("small", "应用文");
    }

    /** 统计里的取值 → 下拉标签（附带"全部"）。 */
    private String[] labelsOf(Map<String, Integer> counts, Map<String, String> labels) {
        List<String> out = new ArrayList<>();
        out.add(ALL);
        List<String> keys = new ArrayList<>(counts.keySet());
        Collections.sort(keys);
        for (String key : keys) out.add(labels.containsKey(key) ? labels.get(key) : key);
        return out.toArray(new String[0]);
    }

    private String[] sortedYears(Map<String, Integer> counts) {
        List<String> years = new ArrayList<>(counts.keySet());
        Collections.sort(years, Collections.reverseOrder());
        List<String> out = new ArrayList<>();
        out.add(ALL);
        out.addAll(years);
        return out.toArray(new String[0]);
    }

    private String labelFor(String[] labels, String raw) {
        if (raw == null || raw.isEmpty()) return ALL;
        for (String label : labels) {
            if (raw.equals(valueFor(label))) return label;
        }
        return ALL;
    }

    private String labelOf(String[] labels, String raw, Map<String, String> mapping) {
        for (String label : labels) {
            if (raw.equals(valueFor(label, mapping))) return label;
        }
        return raw;
    }

    private String valueFor(String label) {
        return valueFor(label, null);
    }

    /** 标签 → 过筛子用的原始取值（含年份这类原样返回的）。 */
    private String valueFor(String label, Map<String, String> mapping) {
        if (label == null || ALL.equals(label)) return "";
        if (mapping != null) {
            for (Map.Entry<String, String> entry : mapping.entrySet()) {
                if (entry.getValue().equals(label)) return entry.getKey();
            }
        }
        // 用 List 而非泛型数组，避免 unchecked 转换（Java 不支持 new Map<String,String>[]）
        for (Map<String, String> table : java.util.Arrays.asList(SUBJECT_LABELS, SECTION_LABELS, ESSAY_TYPE_LABELS)) {
            for (Map.Entry<String, String> entry : table.entrySet()) {
                if (entry.getValue().equals(label)) return entry.getKey();
            }
        }
        return label;
    }

    private static int value(Map<String, Integer> counts, String key) {
        Integer value = counts.get(key);
        return value == null ? 0 : value;
    }

    // ---------- 适配器 ----------

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
            final Dto.ExamBrief exam = items.get(position);
            holder.row.examTitle.setText(exam.listTitle());
            holder.row.examSubtitle.setText(exam.listSubtitle());
            holder.row.examEssayTag.setText(exam.hasEssay ? getString(R.string.rv_pick_has_essay) : "");
            holder.row.examEssayTag.setVisibility(exam.hasEssay ? View.VISIBLE : View.GONE);
            holder.row.getRoot().setOnClickListener(v -> {
                MainActivity activity = (MainActivity) getActivity();
                if (activity != null) activity.openExamDetail(exam.id, exam.listTitle());
            });
        }

        @Override
        public int getItemCount() {
            return items.size();
        }
    }
}
