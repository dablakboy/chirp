import { Text, View, ActivityIndicator, ScrollView, RefreshControl } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/api';

interface SampleResponse {
  message: string;
  timestamp: string;
}

export default function TabTwoScreen() {
  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ['sample'],
    queryFn: () => api.get<SampleResponse>('/api/sample'),
  });

  return (
    <ScrollView
      testID="tab-two-screen"
      className="flex-1 bg-white dark:bg-black"
      contentContainerClassName="flex-1 items-center justify-center px-6"
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={refetch} />
      }
    >
      {isLoading ? (
        <ActivityIndicator testID="loading-indicator" size="large" />
      ) : null}

      {isError ? (
        <View testID="error-view" className="items-center">
          <Text className="text-red-500 text-lg font-semibold">Connection Error</Text>
          <Text className="text-gray-500 mt-2 text-center dark:text-gray-400">
            Could not connect to the backend. Make sure the server is running.
          </Text>
        </View>
      ) : null}

      {data ? (
        <View testID="data-view" className="items-center">
          <Text className="text-2xl font-bold text-black dark:text-white text-center">
            {data.message}
          </Text>
          <Text className="text-sm text-gray-500 mt-4 dark:text-gray-400">
            Timestamp: {data.timestamp}
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
