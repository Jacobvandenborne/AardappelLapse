import React from 'react';
import { StyleSheet, Text, View, Button } from 'react-native';

export default function HomeScreen({ navigation }) {
    return (
        <View style={styles.container}>
            <Text style={styles.title}>Welcome to AardappelLapse</Text>
            <Button
                title="Go to Camera"
                onPress={() => navigation.navigate('Camera')}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#F7EEE3', // Kiezel
        alignItems: 'center',
        justifyContent: 'center',
    },
    title: {
        fontSize: 24,
        fontFamily: 'Montserrat-Bold',
        color: '#000000',
        marginBottom: 20,
    },
});
