<template>
  <!-- keyed so switching revisions re-creates the viewer cleanly -->
  <RouterView :key="route.fullPath" />
</template>

<script setup lang="ts">
import { useRoute } from "vue-router";

const route = useRoute();
</script>
