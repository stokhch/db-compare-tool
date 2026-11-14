<template>
  <div>
    <h2 class="page">Импорт дампа Oracle</h2>
    <div class="panel">
      <p class="hint" style="margin-top:0">Когда к базе-источнику не подключиться, а есть только файл: дамп Data Pump (expdp) или старый exp. Сначала приложение анализирует
        файл и базу-приёмник: формат и версию, кодировку, схемы и объекты, табличные пространства, роли, права, место. Затем предлагает, как
        устранить каждую проблему: удалить или переименовать существующую схему, создать или перенаправить табличные пространства,
        создать роли и пользователей, перевести колонки в CHAR при смене кодировки, скопировать файл на сервер базы. Перед выполнением
        показывается план — SQL и команды импорта.</p>
      <div class="row">
        <div class="field" style="flex:2"><label>Файл дампа (для набора частей exp_01.dmp, exp_02.dmp… — любая из них)</label>
          <div style="display:flex;gap:6px"><DxTextBox v-model:value="form.file" placeholder="C:\dumps\scott.dmp" style="flex:1" value-change-event="input" />
            <DxButton text="Обзор…" icon="folder" styling-mode="outlined" @click="openBrowser" /></div></div>
        <div class="field" style="flex:1"><label>База-приёмник (Oracle на этом компьютере или в сети)</label><ConnSelect v-model="form.targetId" only="oracle" /></div>
      </div>
      <div class="toolbar">
        <div class="field" style="width:240px;margin:0"><label>Пароль шифрования дампа (если есть)</label><DxTextBox v-model:value="form.encryptionPassword" mode="password" /></div>
        <DxCheckBox v-model:value="form.autoCopy" text="Если сервер базы не видит файл — скопировать его через соединение" />
        <DxCheckBox v-model:value="form.decompress" text="Распаковывать .gz" />
        <DxButton text="Анализировать" icon="search" type="default" :disabled="!form.file" @click="analyze" />
      </div>
      <JobPanel v-if="analyzeJob" :job-id="analyzeJob" :report="false" @done="onAnalyzed" />
    </div>

    <template v-if="an">
      <!-- ===== Что в дампе ===== -->
      <div class="panel">
        <h3 style="margin-top:0">Что в дампе</h3>
        <div class="cards">
          <div class="card"><div class="v">{{ { datapump: 'Data Pump', exp: 'exp', unknown: '?' }[an.format] || an.format }}</div><div class="l">формат{{ an.header.parts && an.header.parts.length > 1 ? `, частей ${an.header.parts.length}` : '' }}</div></div>
          <div class="card"><div class="v">{{ fmtSize(an.totalSize || an.header.size) }}</div><div class="l">размер</div></div>
          <div class="card"><div class="v">{{ srcVersion || '—' }}</div><div class="l">версия источника{{ an.target ? ` → ${an.target.version || '?'}` : '' }}</div></div>
          <div class="card"><div class="v">{{ srcCharset || '—' }}</div><div class="l">кодировка{{ an.target ? ` → ${an.target.charset}` : '' }}</div></div>
          <div v-if="an.summary.schemas != null" class="card"><div class="v">{{ an.summary.schemas }}</div><div class="l">схем, объектов {{ an.summary.objects }}</div></div>
          <div v-if="an.directory" class="card"><div class="v" :class="an.directory.visible ? 'ok' : 'error'">{{ an.directory.visible ? an.directory.name : 'нет' }}</div><div class="l">{{ an.directory.copied ? 'скопирован в каталог' : 'каталог Oracle с файлом' }}</div></div>
        </div>
        <div v-if="an.header.jobName" class="hint">Экспорт: задание {{ an.header.jobOwner }}.{{ an.header.jobName }}{{ an.header.mode ? `, режим ${an.header.mode}` : '' }}{{ an.header.platform ? `, платформа ${an.header.platform}` : '' }}</div>
        <DxDataGrid v-if="an.contents && an.contents.schemas.length" :data-source="schemaRows" key-expr="name" :show-borders="true" :word-wrap-enabled="true" style="margin-top:8px"
          :selected-row-keys="dec.selected" @selection-changed="e => (dec.selected = e.selectedRowKeys)">
          <DxSelection mode="multiple" show-check-boxes-mode="always" />
          <DxColumn data-field="name" caption="Схема" :width="180" />
          <DxColumn data-field="objectsText" caption="Объекты" />
          <DxColumn data-field="tablespaces" caption="Табличные пространства" :width="260" />
          <DxColumn data-field="state" caption="В базе-приёмнике" :width="230" cell-template="st" />
          <template #st="{ data }"><span :class="data.data.stateClass">{{ data.value }}</span></template>
        </DxDataGrid>
        <div v-if="an.contents && an.contents.schemas.length" class="hint">Отметьте схемы для импорта (по умолчанию — все).</div>
      </div>

      <!-- ===== Что импортировать ===== -->
      <div v-if="an.contents && an.contents.objects" class="panel">
        <h3 style="margin-top:0">Что импортировать</h3>
        <DxRadioGroup :items="[{ id: 'all', t: 'Отмеченные схемы целиком' }, { id: 'pick', t: 'Только объекты по имени — с зависимостями, которых нет в базе' }]" value-expr="id" display-expr="t" v-model:value="sel.mode" layout="horizontal" />
        <template v-if="sel.mode === 'pick'">
          <div class="toolbar" style="margin-top:8px;align-items:flex-end">
            <div class="field" style="width:220px;margin:0"><label>Имя объекта</label><DxTextBox v-model:value="sel.mask" placeholder="2026" value-change-event="input" @enter-key="pickObjects" /></div>
            <div class="field" style="width:190px;margin:0"><label>Как сравнивать</label>
              <DxSelectBox v-model:value="sel.how" :items="[{ id: 'contains', t: 'содержит' }, { id: 'like', t: 'маска (% и _)' }, { id: 'regex', t: 'регулярное выражение' }]" value-expr="id" display-expr="t" /></div>
            <div class="field" style="width:320px;margin:0"><label>Типы (пусто — все)</label>
              <DxTagBox v-model:value="sel.types" :items="typeItems" value-expr="id" display-expr="t" :show-selection-controls="true" :max-displayed-tags="3" /></div>
            <DxButton text="Подобрать с зависимостями" icon="search" type="default" :disabled="!sel.mask" @click="pickObjects" />
          </div>
          <div class="hint">Ищутся объекты отмеченных схем. Зависимости — таблицы по внешним ключам, последовательности, пакеты, процедуры, функции, типы,
            представления и таблицы, которые использует код, триггеры выбранных таблиц. Если зависимость уже есть в базе-приёмнике{{ an.noTarget ? ' (база не выбрана — проверка не выполняется)' : '' }}, она не импортируется.</div>
          <template v-if="sel.res">
            <div class="cards" style="margin-top:8px">
              <div class="card"><div class="v">{{ sel.res.stats.matched }}</div><div class="l">подходят по имени</div></div>
              <div class="card"><div class="v">{{ sel.res.stats.added }}</div><div class="l">добавлено зависимостей</div></div>
              <div class="card"><div class="v ok">{{ sel.res.stats.existing }}</div><div class="l">зависимостей уже в базе</div></div>
              <div class="card"><div class="v" :class="sel.res.outside.length ? 'warning' : 'ok'">{{ sel.res.outside.length }}</div><div class="l">нет ни в дампе, ни в базе</div></div>
              <div class="card"><div class="v">{{ (dec.objects || []).length }}</div><div class="l">будет импортировано</div></div>
            </div>
            <div v-if="!sel.res.stats.matched" class="warning">Под фильтр не подходит ни один объект (всего в дампе {{ sel.res.total }}).</div>
            <DxDataGrid v-else :data-source="sel.res.rows" key-expr="id" :show-borders="true" :height="Math.min(420, 60 + sel.res.rows.length * 34)" :word-wrap-enabled="true"
              :selected-row-keys="dec.objects" @selection-changed="e => (dec.objects = e.selectedRowKeys)">
              <DxSelection mode="multiple" show-check-boxes-mode="always" /><DxScrolling mode="virtual" /><DxSearchPanel :visible="true" />
              <DxColumn data-field="owner" caption="Схема" :width="140" />
              <DxColumn data-field="type" caption="Тип" :width="160" :calculate-display-value="r => TYPE_LABEL[r.type] || r.type" />
              <DxColumn data-field="name" caption="Объект" />
              <DxColumn caption="Почему" :calculate-cell-value="whyText" />
            </DxDataGrid>
            <details v-if="sel.res.existing.length" style="margin-top:6px"><summary>Зависимости, которые уже есть в базе и не импортируются ({{ sel.res.existing.length }})</summary>
              <div class="mono" style="max-height:160px;overflow:auto">{{ sel.res.existing.map(x => `${x.owner}.${x.name} (${TYPE_LABEL[x.type] || x.type}) ← ${x.usedBy.map(short).join(', ')}`).join('\n') }}</div></details>
            <div v-if="sel.res.outside.length || sel.res.dblinks.length" class="issue warning" style="margin-top:8px">
              <div class="issue-title"><span class="dot">●</span> Выбранный код ссылается на то, чего нет ни в дампе, ни в базе</div>
              <div class="issue-details">Эти объекты после импорта будут невалидными. Импортируйте недостающее из другого дампа или создайте вручную.</div>
              <div class="mono" style="max-height:160px;overflow:auto">{{ [...sel.res.outside.map(x => `${x.ref} — ${x.reason}; используется в: ${x.usedBy.join(', ')}`), ...sel.res.dblinks.map(x => `DB link ${x.link}: ${x.usedBy.join(', ')}`)].join('\n') }}</div>
            </div>
          </template>
        </template>
      </div>

      <!-- ===== Проблемы и решения ===== -->
      <div class="panel">
        <h3 style="margin-top:0">Проблемы и решения <span class="hint">— ошибок {{ an.summary.errors }}, предупреждений {{ an.summary.warnings }}</span></h3>
        <div v-if="!an.issues.length" class="ok">Препятствий для импорта не найдено.</div>
        <div v-for="i in an.issues" :key="i.id" class="issue" :class="i.level">
          <div class="issue-title"><span class="dot">●</span> {{ i.title }}</div>
          <div class="issue-details">{{ i.details }}</div>
          <pre v-if="i.sql" class="cmd">{{ i.sql }}</pre>
          <details v-if="i.list && i.list.length"><summary>Список ({{ i.list.length }})</summary><div class="mono" style="max-height:160px;overflow:auto">{{ i.list.join('\n') }}</div></details>

          <!-- схема существует / пользователя нет -->
          <template v-if="i.schema && i.fixes.length && dec.schemas[i.schema]">
            <DxRadioGroup :items="i.fixes" value-expr="id" display-expr="title" :value="dec.schemas[i.schema].action" @value-changed="e => setSchema(i, e.value)" />
            <div v-if="dec.schemas[i.schema].action === 'remap'" class="field" style="width:280px;margin:6px 0 0 24px"><label>Новое имя схемы</label>
              <DxTextBox :value="dec.schemas[i.schema].target" @value-changed="e => (dec.schemas[i.schema].target = (e.value || '').toUpperCase())" /></div>
            <div v-if="dec.schemas[i.schema].action === 'create'" class="field" style="width:280px;margin:6px 0 0 24px"><label>Пароль нового пользователя</label>
              <DxTextBox v-model:value="dec.schemas[i.schema].password" /></div>
            <div v-if="dec.schemas[i.schema].action === 'drop'" class="error" style="margin:4px 0 0 24px">Все объекты и данные схемы {{ i.schema }} будут удалены без возможности восстановления.</div>
          </template>
          <!-- табличное пространство -->
          <template v-else-if="i.tablespace && dec.tablespaces[i.tablespace]">
            <DxRadioGroup :items="i.fixes" value-expr="id" display-expr="title" layout="horizontal" v-model:value="dec.tablespaces[i.tablespace].action" />
            <div v-if="dec.tablespaces[i.tablespace].action === 'remap'" class="field" style="width:280px;margin:6px 0 0 24px"><label>Куда</label>
              <DxSelectBox v-model:value="dec.tablespaces[i.tablespace].to" :items="tsNames(dec.tablespaces[i.tablespace].temp)" :accept-custom-value="true" /></div>
            <div v-else class="field" style="width:200px;margin:6px 0 0 24px"><label>Начальный размер, МБ</label><DxNumberBox v-model:value="dec.tablespaces[i.tablespace].sizeMb" :min="10" /></div>
          </template>
          <!-- флажки -->
          <template v-else>
            <template v-for="f in i.fixes" :key="f.id">
              <DxCheckBox v-if="FLAG[f.id]" :text="f.title" :value="!!dec[FLAG[f.id]]" @value-changed="e => (dec[FLAG[f.id]] = e.value)" />
              <div v-else-if="f.input === 'password'" class="field" style="width:280px"><label>{{ f.title }}</label><DxTextBox v-model:value="form.encryptionPassword" mode="password" /></div>
            </template>
          </template>
        </div>
        <div class="toolbar" style="margin-top:10px">
          <DxCheckBox v-model:value="dec.recompile" text="Перекомпилировать схемы после импорта" />
          <div v-if="an.format === 'datapump'" class="field" style="width:140px;margin:0"><label>Параллельно</label><DxNumberBox v-model:value="dec.parallel" :min="1" :max="16" :show-spin-buttons="true" /></div>
          <DxButton text="Повторить анализ" icon="refresh" styling-mode="outlined" @click="analyze" />
        </div>
      </div>

      <!-- ===== План ===== -->
      <div v-if="!an.noTarget" class="panel">
        <h3 style="margin-top:0">План импорта</h3>
        <div v-if="plan && plan.blocking.length" class="issue error"><div class="issue-title">Нужно решить перед импортом:</div><div v-for="b in plan.blocking" :key="b">• {{ b }}</div></div>
        <template v-if="plan">
          <div v-if="plan.pre.length"><b>1. Подготовка базы</b>
            <div v-for="(s, k) in plan.pre" :key="k" class="step" :class="{ danger: s.danger }"><span>{{ s.title }}</span><pre class="cmd">{{ s.secret ? s.sql.replace(s.secret, '***') : s.sql }}</pre></div></div>
          <div v-if="plan.jobs"><b>{{ plan.pre.length ? 2 : 1 }}. Data Pump</b>
            <div v-for="(j, k) in plan.jobs" :key="k" class="step"><span>{{ j.title }}</span>
              <pre v-if="j.between" class="cmd">{{ j.between.slice(0, 20).map(x => x.sql).join(';\n') }}{{ j.between.length > 20 ? `\n… ещё ${j.between.length - 20}` : '' }}</pre>
              <pre v-else class="cmd">{{ plan.commands[plan.jobs.filter(x => !x.between).indexOf(j)] }}</pre></div></div>
          <div v-if="plan.imp"><b>{{ plan.pre.length ? 2 : 1 }}. imp</b><pre class="cmd">imp parfile: fromuser=({{ plan.imp.fromuser.join(',') }}) touser=({{ plan.imp.touser.join(',') }}){{ plan.imp.tables ? ` tables=(${plan.imp.tables.join(',')})` : '' }} ignore=y grants=y indexes=y constraints=y commit=y; NLS_LANG=AMERICAN_AMERICA.{{ srcCharset || 'AL32UTF8' }}</pre></div>
          <div v-for="n in plan.notes || []" :key="n" class="issue warning" style="margin-top:6px">{{ n }}</div>
          <div v-if="plan.post.length"><b>После импорта:</b> {{ plan.post.map(x => x.title).join('; ') }}, проверка невалидных объектов и количества объектов по типам.</div>
        </template>
        <div class="toolbar" style="margin-top:10px">
          <DxButton text="Импортировать" icon="runner" type="default" :disabled="!plan || plan.blocking.length > 0 || !form.targetId" @click="startImport" />
          <span v-if="plan && plan.pre.some(s => s.danger)" class="error">В плане есть необратимые действия (удаление схем) — будет запрошено подтверждение.</span>
        </div>
        <JobPanel v-if="importJob" :job-id="importJob" :report="false" @done="j => (res = j.result)" />
      </div>
    </template>

    <!-- ===== Результат ===== -->
    <div v-if="res" class="panel">
      <h3 style="margin-top:0">Результат импорта</h3>
      <div class="cards">
        <div class="card"><div class="v" :class="{ OK: 'ok', WARNINGS: 'warning', FAILED: 'error' }[res.summary.state]">{{ { OK: 'успешно', WARNINGS: 'с ошибками', FAILED: 'не завершён' }[res.summary.state] }}</div><div class="l">{{ fmtMs(res.summary.ms) }}</div></div>
        <div class="card"><div class="v">{{ fmtNum(res.summary.rows) }}</div><div class="l">строк в {{ res.summary.tables }} таблицах</div></div>
        <div class="card"><div class="v" :class="res.summary.errors ? 'error' : 'ok'">{{ res.summary.errors }}</div><div class="l">ошибок ({{ res.summary.errorGroups }} видов)</div></div>
        <div class="card"><div class="v">{{ res.summary.benign }}</div><div class="l">безвредных сообщений</div></div>
        <div class="card"><div class="v" :class="res.summary.invalid ? 'warning' : 'ok'">{{ res.summary.invalid }}</div><div class="l">невалидных объектов</div></div>
      </div>
      <div v-if="res.passwords && res.passwords.length" class="issue warning"><div class="issue-title">Созданы пользователи — сохраните пароли:</div>
        <div v-for="p in res.passwords" :key="p.title" class="mono">{{ p.title }}: {{ p.password }}</div></div>
      <div v-if="res.fixes.length" class="toolbar">
        <span>Приложение может исправить часть ошибок при повторном запуске.</span>
        <DxButton text="Применить исправления и повторить анализ" icon="refresh" type="default" @click="applyFixes" />
        <DxButton text="Перенести в PostgreSQL" icon="export" styling-mode="outlined" @click="$router.push('/migrate')" />
      </div>
      <h4>Этапы</h4>
      <DxDataGrid :data-source="res.phases" :show-borders="true" :word-wrap-enabled="true">
        <DxColumn data-field="title" caption="Этап" />
        <DxColumn data-field="state" caption="Состояние" :width="200" />
        <DxColumn data-field="errors" caption="Ошибок" :width="90" />
        <DxColumn data-field="ms" caption="Время" :width="100" :calculate-display-value="r => (r.ms ? fmtMs(r.ms) : '')" />
        <DxColumn data-field="logFile" caption="Журнал на сервере" :width="260" />
      </DxDataGrid>
      <h4>Ошибки и что с ними делать</h4>
      <div class="toolbar"><DxCheckBox v-model:value="showBenign" text="Показывать безвредные сообщения" /></div>
      <DxDataGrid :data-source="res.errors.filter(e => showBenign || !e.benign)" :show-borders="true" :word-wrap-enabled="true" no-data-text="Ошибок нет">
        <DxColumn data-field="code" caption="Код" :width="100" />
        <DxColumn data-field="title" caption="Что случилось" :width="260" />
        <DxColumn data-field="count" caption="Раз" :width="60" />
        <DxColumn data-field="hint" caption="Что делать" />
        <DxColumn caption="Объекты" :calculate-cell-value="e => e.objects.slice(0, 10).join(', ') + (e.objects.length > 10 ? '…' : '')" css-class="mono" :width="240" />
        <DxMasterDetail :enabled="true" template="det" />
        <template #det="{ data }"><div v-for="(s, k) in data.data.samples" :key="k" class="mono">{{ s }}</div></template>
      </DxDataGrid>
      <template v-if="res.invalid.length">
        <h4>Невалидные объекты после перекомпиляции</h4>
        <DxDataGrid :data-source="res.invalid" :show-borders="true" :word-wrap-enabled="true">
          <DxSearchPanel :visible="true" /><DxPaging :page-size="20" />
          <DxColumn data-field="schema" caption="Схема" :width="140" /><DxColumn data-field="type" caption="Тип" :width="140" /><DxColumn data-field="name" caption="Объект" :width="240" />
          <DxColumn caption="Ошибки" :calculate-cell-value="o => o.errors.join('; ')" css-class="mono" />
        </DxDataGrid>
      </template>
      <template v-if="countsDiff.length">
        <h4>Объектов меньше, чем в дампе</h4>
        <DxDataGrid :data-source="countsDiff" :show-borders="true">
          <DxColumn data-field="schema" caption="Схема" /><DxColumn data-field="type" caption="Тип" /><DxColumn data-field="expected" caption="В дампе" /><DxColumn data-field="actual" caption="В базе" />
        </DxDataGrid>
      </template>
      <details v-if="res.rows.length" style="margin-top:8px"><summary>Загружено по таблицам ({{ res.rows.length }})</summary>
        <DxDataGrid :data-source="res.rows" :show-borders="true" :height="300"><DxScrolling mode="virtual" /><DxSearchPanel :visible="true" />
          <DxColumn data-field="owner" caption="Схема" /><DxColumn data-field="table" caption="Таблица" /><DxColumn data-field="partition" caption="Секция" />
          <DxColumn data-field="size" caption="Объём" /><DxColumn data-field="rows" caption="Строк" data-type="number" format="#,##0" /></DxDataGrid></details>
    </div>

    <DxPopup v-model:visible="br.visible" title="Выбор файла дампа" :width="760" :height="560" :show-close-button="true">
      <div>
        <div class="toolbar"><DxButton icon="arrowup" styling-mode="outlined" :disabled="br.parent === null" @click="browse(br.parent)" />
          <DxTextBox :value="br.path" style="flex:1" @enter-key="e => browse(e.component.option('value'))" /></div>
        <DxDataGrid :data-source="br.entries" :show-borders="true" :height="400" :hover-state-enabled="true" @row-click="e => pick(e.data)">
          <DxScrolling mode="virtual" />
          <DxColumn caption="" :width="40" :calculate-cell-value="e => (e.dir ? '📁' : '🗄️')" />
          <DxColumn data-field="name" caption="Имя" />
          <DxColumn data-field="size" caption="Размер" :width="120" :calculate-display-value="e => (e.size != null ? fmtSize(e.size) : '')" />
        </DxDataGrid>
        <div class="hint">Показаны папки и файлы .dmp, .exp, .dump, .gz.</div>
      </div>
    </DxPopup>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { DxButton } from 'devextreme-vue/button';
import { DxCheckBox } from 'devextreme-vue/check-box';
import { DxTextBox } from 'devextreme-vue/text-box';
import { DxNumberBox } from 'devextreme-vue/number-box';
import { DxSelectBox } from 'devextreme-vue/select-box';
import { DxRadioGroup } from 'devextreme-vue/radio-group';
import { DxPopup } from 'devextreme-vue/popup';
import { DxTagBox } from 'devextreme-vue/tag-box';
import { DxDataGrid, DxColumn, DxSelection, DxMasterDetail, DxSearchPanel, DxPaging, DxScrolling } from 'devextreme-vue/data-grid';
import { confirm } from 'devextreme/ui/dialog';
import ConnSelect from '../components/ConnSelect.vue';
import JobPanel from '../components/JobPanel.vue';
import { api, safe, toast, fmtMs, fmtNum } from '../api';
import { useJobFromRoute } from '../jobroute';

const saved = (() => { try { return JSON.parse(localStorage.getItem('dbcompare.dumpimport') || '{}'); } catch { return {}; } })();
const form = reactive({ file: saved.file || '', targetId: saved.targetId || null, encryptionPassword: '', autoCopy: true, decompress: true });
const analyzeJob = ref(null), importJob = ref(null);
const an = ref(null), res = ref(null), plan = ref(null);
const dec = reactive({ schemas: {}, tablespaces: {}, selected: [] });
const showBenign = ref(false);
// выборочный импорт
const TYPE_LABEL = { TABLE: 'таблица', VIEW: 'представление', SEQUENCE: 'последовательность', SYNONYM: 'синоним', PACKAGE: 'пакет', PROCEDURE: 'процедура', FUNCTION: 'функция', TYPE: 'тип', 'MATERIALIZED VIEW': 'мат. представление', TRIGGER: 'триггер' };
const typeItems = Object.entries(TYPE_LABEL).map(([id, t]) => ({ id, t }));
const sel = reactive({ mode: 'all', mask: '', how: 'contains', types: [], res: null });
const short = id => id.replace(/^[^:]+:/, '');
const whyText = r => (r.reason === 'mask' ? `подходит по имени${r.exists ? ' (уже есть в базе — см. действие для схемы)' : ''}` : r.reason === 'trigger' ? `триггер таблицы ${short(r.via)}` : `нужен для ${short(r.via)}`);
watch(() => sel.mode, m => { if (m === 'all') dec.objects = []; else if (sel.res) dec.objects = sel.res.rows.map(r => r.id); });
async function pickObjects() {
  if (!sel.mask) return;
  const schemas = dec.selected && dec.selected.length ? dec.selected : [];
  const r = await safe(() => api.post('/dump/select', { analysisJobId: analyzeJob.value, targetId: form.targetId || undefined, decisions: JSON.parse(JSON.stringify({ ...dec, objects: [] })), filter: { mask: sel.mask, mode: sel.how, types: sel.types, schemas } }));
  if (!r) return;
  sel.res = r;
  dec.objects = r.rows.map(x => x.id);
}
const FLAG = { byteToChar: 'byteToChar', createRoles: 'createRoles', excludeDbLinks: 'excludeDbLinks', excludeJobs: 'excludeJobs', excludeTablespaces: 'excludeTablespaces', dropStaleJobs: 'dropStaleJobs', copy: 'copy', decompress: 'decompress' };

const fmtSize = b => (b == null ? '' : b > 1073741824 ? `${(b / 1073741824).toFixed(1)} ГБ` : b > 1048576 ? `${(b / 1048576).toFixed(1)} МБ` : `${Math.ceil(b / 1024)} КБ`);
const srcVersion = computed(() => an.value && ((an.value.dumpInfo && an.value.dumpInfo.dbVersion) || an.value.header.dbVersion));
const srcCharset = computed(() => an.value && ((an.value.dumpInfo && an.value.dumpInfo.charset) || an.value.header.charset));
const schemaRows = computed(() => (an.value && an.value.contents ? an.value.contents.schemas.map(s => {
  const u = an.value.target && an.value.target.users[s.name];
  const state = !an.value.target ? '' : !u || !u.exists ? (s.createUser ? 'нет — создаст импорт' : 'нет пользователя') : u.total ? `есть, объектов ${u.total}${u.sessions ? `, сеансов ${u.sessions}` : ''}` : 'есть, пустая';
  return { name: s.name, objectsText: Object.entries(s.objects).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(', ') || '—', tablespaces: s.tablespaces.join(', '), state,
    stateClass: !u || !u.exists ? (s.createUser ? 'ok' : 'warning') : u.total ? 'error' : 'ok' };
}) : []));
const countsDiff = computed(() => (res.value ? res.value.counts.filter(c => c.actual < c.expected && !/BODY|LOB/.test(c.type)) : []));
const tsNames = temp => (an.value && an.value.target ? an.value.target.tablespaces.filter(t => (temp ? t.contents === 'TEMPORARY' : t.contents === 'PERMANENT')).map(t => t.name) : []);

function remember() { localStorage.setItem('dbcompare.dumpimport', JSON.stringify({ file: form.file, targetId: form.targetId })); }
async function analyze() {
  remember();
  an.value = null; plan.value = null; res.value = null; importJob.value = null;
  const j = await safe(() => api.post('/jobs/dump-analyze', { file: form.file, targetId: form.targetId || undefined, encryptionPassword: form.encryptionPassword || undefined, autoCopy: form.autoCopy, decompress: form.decompress }));
  if (j) analyzeJob.value = j.id;
}
function onAnalyzed(j) {
  if (!j.result) return;
  an.value = j.result;
  const d = JSON.parse(JSON.stringify(j.result.defaults || {}));
  for (const k of Object.keys(dec)) delete dec[k];
  Object.assign(dec, { schemas: {}, tablespaces: {}, selected: [], objects: [], copy: true, ...d });
  sel.res = null; sel.mode = 'all';
  if (pendingFixes) { Object.assign(dec, pendingFixes); pendingFixes = null; }
  if (j.result.file) form.file = j.result.file;
}
function setSchema(i, action) {
  const s = dec.schemas[i.schema];
  s.action = action;
  if (action === 'remap' && !s.target || action === 'remap' && s.target === i.schema) { const f = i.fixes.find(x => x.id === 'remap'); s.target = (f && f.suggestion) || `${i.schema}_IMP`; }
  if (action !== 'remap') s.target = i.schema;
}

let timer = null;
watch(dec, () => { clearTimeout(timer); timer = setTimeout(refreshPlan, 300); }, { deep: true });
async function refreshPlan() {
  if (!analyzeJob.value || !an.value || an.value.noTarget) return;
  const r = await safe(() => api.post('/dump/plan', { analysisJobId: analyzeJob.value, decisions: JSON.parse(JSON.stringify(dec)) }));
  if (r) plan.value = r;
}
async function startImport() {
  const danger = plan.value.pre.filter(s => s.danger);
  if (danger.length) {
    const ok = await confirm(`<div>Будут выполнены необратимые действия:</div><ul>${danger.map(s => `<li>${s.title}</li>`).join('')}</ul><div>Продолжить?</div>`, 'Подтверждение');
    if (!ok) return;
  }
  res.value = null;
  const j = await safe(() => api.post('/jobs/dump-import', { analysisJobId: analyzeJob.value, targetId: form.targetId, decisions: JSON.parse(JSON.stringify(dec)), encryptionPassword: form.encryptionPassword || undefined, title: dec.objects && dec.objects.length ? `${sel.mask}: объектов ${dec.objects.length}` : (dec.selected || []).join(', ') }));
  if (j) importJob.value = j.id;
}
let pendingFixes = null;
function applyFixes() {
  const f = {};
  for (const x of res.value.fixes) {
    if (x === 'byteToChar') f.byteToChar = true;
    if (x === 'createRoles') f.createRoles = true;
    if (x === 'excludeDbLinks') f.excludeDbLinks = true;
    if (x === 'oid') f.oidTransform = true;
    if (x === 'staleJobs') f.dropStaleJobs = true;
    if (x === 'copy') form.autoCopy = true;
  }
  pendingFixes = f;
  const extra = res.value.fixes.filter(x => ['tableExists', 'tablespaces', 'createUser', 'privileges', 'quota', 'space', 'password'].includes(x));
  toast(extra.length ? 'Повторный анализ покажет схемы, уже созданные первым запуском, — выберите для них «Удалить» или «Пересоздать таблицы».' : 'Исправления будут применены после анализа');
  analyze();
}

// выбор файла
const br = reactive({ visible: false, path: '', parent: null, entries: [] });
async function browse(p) {
  const r = await safe(() => api.get(`/fs/list?path=${encodeURIComponent(p || '')}`));
  if (r) Object.assign(br, { path: r.path, parent: r.parent, entries: r.entries });
}
function openBrowser() {
  br.visible = true;
  const f = form.file;
  browse(f ? f.replace(/[\\/][^\\/]*$/, '') : '');
}
function pick(e) { if (e.dir) browse(e.path); else { form.file = e.path; br.visible = false; } }

useJobFromRoute(['dump-analyze', 'dump-import'], async j => {
  if (j.type === 'dump-analyze') { analyzeJob.value = j.id; if (j.params && j.params.file) form.file = j.params.file; if (j.params && j.params.targetId) form.targetId = j.params.targetId; }
  else { analyzeJob.value = j.params.analysisJobId; form.targetId = j.params.targetId; const a = await safe(() => api.get(`/jobs/${j.params.analysisJobId}`)); if (a) onAnalyzed(a); importJob.value = j.id; }
});
</script>

<style scoped>
.issue { border-left: 4px solid #98a2b3; background: #f9fafb; padding: 8px 12px; margin-bottom: 8px; border-radius: 4px; }
.issue.error { border-color: #d92d20; background: #fef3f2; }
.issue.warning { border-color: #dc6803; background: #fffaeb; }
.issue.info { border-color: #1570ef; background: #eff8ff; }
.issue-title { font-weight: 600; margin-bottom: 2px; }
.issue.error .dot { color: #d92d20; } .issue.warning .dot { color: #dc6803; } .issue.info .dot { color: #1570ef; }
.issue-details { margin-bottom: 6px; }
.step { margin: 4px 0 4px 12px; }
.step.danger > span { color: #d92d20; font-weight: 600; }
.step pre { margin: 2px 0 6px; }
</style>
