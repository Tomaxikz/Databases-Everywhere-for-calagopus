import type { DatabaseProtocol } from '../../api/types.ts';
import translations from '../../translations.ts';

export interface DataStructureLabels {
  title: string;
  definedDescription: string;
  inferredDescription: string;
  nameHeader: string;
}

export interface DataRecordLabels {
  title: string;
  description: string;
  filterPlaceholder: string;
  filtered: (visible: number, loaded: number) => string;
  create: string;
  createTitle: string;
  edit: string;
  delete: string;
  select: (number: number) => string;
  selectVisible: string;
  selected: (count: number) => string;
  deleteSelected: string;
  deleteSelectedTitle: (count: number) => string;
  deleteSelectedWarning: (count: number) => string;
  selectedDeleted: (count: number) => string;
  save: string;
  deleteWarning: string;
  saved: string;
  deleted: string;
}

export interface DataEditorTerminology {
  structure: DataStructureLabels;
  records: DataRecordLabels;
  emptySelection: string;
}

export default function dataEditorTerminology(protocol: DatabaseProtocol): DataEditorTerminology {
  const { t } = translations.getTranslations();

  if (protocol === 'mongodb') {
    return {
      structure: {
        title: t('server.dataEditor.mongodbTerms.fields', {}),
        definedDescription: t('server.dataEditor.mongodbTerms.inferredFieldsDescription', {}),
        inferredDescription: t('server.dataEditor.mongodbTerms.inferredFieldsDescription', {}),
        nameHeader: t('server.dataEditor.fieldName', {}),
      },
      records: {
        title: t('server.dataEditor.mongodbTerms.documents', {}),
        description: t('server.dataEditor.mongodbTerms.documentsDescription', {}),
        filterPlaceholder: t('server.dataEditor.mongodbTerms.filterDocuments', {}),
        filtered: (visible, loaded) => t('server.dataEditor.mongodbTerms.filteredDocuments', { visible, loaded }),
        create: t('server.dataEditor.mongodbTerms.newDocument', {}),
        createTitle: t('server.dataEditor.mongodbTerms.createDocument', {}),
        edit: t('server.dataEditor.mongodbTerms.editDocument', {}),
        delete: t('server.dataEditor.mongodbTerms.deleteDocument', {}),
        select: (number) => t('server.dataEditor.mongodbTerms.selectDocument', { number }),
        selectVisible: t('server.dataEditor.mongodbTerms.selectVisibleDocuments', {}),
        selected: (count) => t('server.dataEditor.mongodbTerms.documentsSelected', { count }),
        deleteSelected: t('server.dataEditor.mongodbTerms.deleteSelected', {}),
        deleteSelectedTitle: (count) => t('server.dataEditor.mongodbTerms.deleteSelectedTitle', { count }),
        deleteSelectedWarning: (count) => t('server.dataEditor.mongodbTerms.deleteSelectedWarning', { count }),
        selectedDeleted: (count) => t('server.dataEditor.mongodbTerms.selectedDeleted', { count }),
        save: t('server.dataEditor.mongodbTerms.saveDocument', {}),
        deleteWarning: t('server.dataEditor.mongodbTerms.deleteWarning', {}),
        saved: t('server.dataEditor.mongodbTerms.saved', {}),
        deleted: t('server.dataEditor.mongodbTerms.deleted', {}),
      },
      emptySelection: t('server.dataEditor.mongodbTerms.selectCollection', {}),
    };
  }

  if (protocol === 'qdrant') {
    return {
      structure: {
        title: t('server.dataEditor.qdrantTerms.fields', {}),
        definedDescription: t('server.dataEditor.qdrantTerms.inferredFieldsDescription', {}),
        inferredDescription: t('server.dataEditor.qdrantTerms.inferredFieldsDescription', {}),
        nameHeader: t('server.dataEditor.fieldName', {}),
      },
      records: {
        title: t('server.dataEditor.qdrantTerms.points', {}),
        description: t('server.dataEditor.qdrantTerms.pointsDescription', {}),
        filterPlaceholder: t('server.dataEditor.qdrantTerms.filterPoints', {}),
        filtered: (visible, loaded) => t('server.dataEditor.qdrantTerms.filteredPoints', { visible, loaded }),
        create: t('server.dataEditor.qdrantTerms.newPoint', {}),
        createTitle: t('server.dataEditor.qdrantTerms.createPoint', {}),
        edit: t('server.dataEditor.qdrantTerms.editPoint', {}),
        delete: t('server.dataEditor.qdrantTerms.deletePoint', {}),
        select: (number) => t('server.dataEditor.qdrantTerms.selectPoint', { number }),
        selectVisible: t('server.dataEditor.qdrantTerms.selectVisiblePoints', {}),
        selected: (count) => t('server.dataEditor.qdrantTerms.pointsSelected', { count }),
        deleteSelected: t('server.dataEditor.qdrantTerms.deleteSelected', {}),
        deleteSelectedTitle: (count) => t('server.dataEditor.qdrantTerms.deleteSelectedTitle', { count }),
        deleteSelectedWarning: (count) => t('server.dataEditor.qdrantTerms.deleteSelectedWarning', { count }),
        selectedDeleted: (count) => t('server.dataEditor.qdrantTerms.selectedDeleted', { count }),
        save: t('server.dataEditor.qdrantTerms.savePoint', {}),
        deleteWarning: t('server.dataEditor.qdrantTerms.deleteWarning', {}),
        saved: t('server.dataEditor.qdrantTerms.saved', {}),
        deleted: t('server.dataEditor.qdrantTerms.deleted', {}),
      },
      emptySelection: t('server.dataEditor.qdrantTerms.selectCollection', {}),
    };
  }

  if (protocol === 'redis' || protocol === 'valkey') {
    return {
      structure: {
        title: t('server.dataEditor.keyValueTerms.fields', {}),
        definedDescription: t('server.dataEditor.keyValueTerms.inferredFieldsDescription', {}),
        inferredDescription: t('server.dataEditor.keyValueTerms.inferredFieldsDescription', {}),
        nameHeader: t('server.dataEditor.fieldName', {}),
      },
      records: {
        title: t('server.dataEditor.keyValueTerms.value', {}),
        description: t('server.dataEditor.keyValueTerms.valueDescription', {}),
        filterPlaceholder: t('server.dataEditor.keyValueTerms.filterValue', {}),
        filtered: (visible, loaded) => t('server.dataEditor.keyValueTerms.filteredValue', { visible, loaded }),
        create: t('server.dataEditor.keyValueTerms.replaceValue', {}),
        createTitle: t('server.dataEditor.keyValueTerms.replaceValue', {}),
        edit: t('server.dataEditor.keyValueTerms.editValue', {}),
        delete: t('server.dataEditor.keyValueTerms.deleteKey', {}),
        select: (_number) => t('server.dataEditor.keyValueTerms.selectValue', {}),
        selectVisible: t('server.dataEditor.keyValueTerms.selectVisibleValue', {}),
        selected: (count) => t('server.dataEditor.keyValueTerms.valueSelected', { count }),
        deleteSelected: t('server.dataEditor.keyValueTerms.deleteSelected', {}),
        deleteSelectedTitle: (_count) => t('server.dataEditor.keyValueTerms.deleteSelectedTitle', {}),
        deleteSelectedWarning: (_count) => t('server.dataEditor.keyValueTerms.deleteSelectedWarning', {}),
        selectedDeleted: (_count) => t('server.dataEditor.keyValueTerms.selectedDeleted', {}),
        save: t('server.dataEditor.keyValueTerms.saveValue', {}),
        deleteWarning: t('server.dataEditor.keyValueTerms.deleteWarning', {}),
        saved: t('server.dataEditor.keyValueTerms.saved', {}),
        deleted: t('server.dataEditor.keyValueTerms.deleted', {}),
      },
      emptySelection: t('server.dataEditor.keyValueTerms.selectKey', {}),
    };
  }

  return {
    structure: {
      title: t('server.dataEditor.columns', {}),
      definedDescription: t('server.dataEditor.columnsDescription', {}),
      inferredDescription: t('server.dataEditor.inferredColumnsDescription', {}),
      nameHeader: t('server.dataEditor.columnHeader', {}),
    },
    records: {
      title: t('server.dataEditor.rowBrowser', {}),
      description: t('server.dataEditor.rowBrowserDescription', {}),
      filterPlaceholder: t('server.dataEditor.filterRows', {}),
      filtered: (visible, loaded) => t('server.dataEditor.filteredRows', { visible, loaded }),
      create: t('server.dataEditor.newRow', {}),
      createTitle: t('server.dataEditor.createRow', {}),
      edit: t('server.dataEditor.editRow', {}),
      delete: t('server.dataEditor.deleteRow', {}),
      select: (number) => t('server.dataEditor.selectRow', { number }),
      selectVisible: t('server.dataEditor.selectVisibleRows', {}),
      selected: (count) => t('server.dataEditor.rowsSelected', { count }),
      deleteSelected: t('server.dataEditor.deleteSelected', {}),
      deleteSelectedTitle: (count) => t('server.dataEditor.deleteSelectedRows', { count }),
      deleteSelectedWarning: (count) => t('server.dataEditor.deleteSelectedRowsWarning', { count }),
      selectedDeleted: (count) => t('server.dataEditor.selectedRowsDeleted', { count }),
      save: t('server.dataEditor.saveRow', {}),
      deleteWarning: t('server.deleteRecordWarning', {}),
      saved: t('server.mutationSaved', {}),
      deleted: t('server.mutationDeleted', {}),
    },
    emptySelection: t('server.dataEditor.selectRelationalTable', {}),
  };
}
