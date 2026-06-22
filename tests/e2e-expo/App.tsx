import { StatusBar } from 'expo-status-bar'
import { StyleSheet, View } from 'react-native'

import GroupEncryption from './components/GroupEncryption'

export default function App() {
  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <GroupEncryption />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 10,
  },
})
